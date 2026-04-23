import { chromium, type BrowserContext, type Cookie } from 'playwright';
import { logger } from '../utils/logger';
import * as fs from 'node:fs';
import { resolve } from 'node:path';

const LOGIN_URL = 'https://engage.nkcswx.cn/Login.aspx';
const COOKIE_FILE_PATH = resolve(import.meta.dir, 'cookies.json');

let _inMemoryCookies: Cookie[] | null = null;

// Login lock to prevent concurrent login attempts
let _loginLock: Promise<Cookie[]> | null = null;

// Cookie backup: preserved before clearCookieCache, restored on re-login failure
let _cookieBackup: Cookie[] | null = null;

// Auth failure throttle: debounce consecutive re-login triggers from 500 errors
// Prevents thundering herd when server is slow and returns many 500s
let _authFailureCooldownUntil = 0;
const AUTH_FAILURE_COOLDOWN_MS = 15000; // 15s cooldown between re-login cycles

/**
 * Put all callers to wait during auth cooldown window.
 * Returns true if auth is allowed (outside cooldown), false if throttled.
 */
export function tryAcquireAuthLock(): boolean {
  const now = Date.now();
  if (now < _authFailureCooldownUntil) {
    const remaining = _authFailureCooldownUntil - now;
    logger.warn(
      `Re-login throttled: ${Math.round(remaining / 1000)}s cooldown remaining. ` +
      `Existing cookies are likely still valid — server 500 is a temporary slowdown.`
    );
    return false;
  }
  return true;
}

/**
 * Called after a successful re-login to release the cooldown.
 */
export function releaseAuthCooldown(): void {
  _authFailureCooldownUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
  logger.info(`Auth cooldown set: ${AUTH_FAILURE_COOLDOWN_MS}ms to prevent thundering herd re-logins.`);
}

/**
 * Ensure only one login process runs at a time
 */
export async function ensureSingleLogin(username: string, password: string): Promise<Cookie[]> {
  // Wait for any existing login to complete
  if (_loginLock) {
    logger.info('Login in progress, waiting for existing login to complete...');
    await _loginLock;
  }
  
  // Create new lock promise for this login attempt
  _loginLock = (async () => {
    try {
      return await loginWithPlaywright(username, password);
    } finally {
      _loginLock = null;
    }
  })();
  
  return await _loginLock;
}

/**
 * Login using Playwright and extract cookies
 */
export async function loginWithPlaywright(username: string, password: string): Promise<Cookie[]> {
  logger.info('Starting Playwright login process...');
  
  const browserLaunchOptions: any = { 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  const browser = await chromium.launch(browserLaunchOptions);

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    
    logger.info(`Navigating to login page: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { 
      waitUntil: 'networkidle',
      timeout: 30000
    });

    logger.info('Login page loaded. Filling form...');

    const usernameField = page.locator('input[name="ctl00$PageContent$loginControl$txtUN"]');
    await usernameField.fill(decodeURIComponent(username));

    const passwordField = page.locator('input[name="ctl00$PageContent$loginControl$txtPwd"]');
    await passwordField.fill(decodeURIComponent(password));

    const rememberMe = page.locator('input[name="ctl00$PageContent$loginControl$cbRememberMe"]');
    await rememberMe.check().catch(() => {
      logger.debug('Could not check remember me checkbox (optional)');
    });

    const loginButton = page.locator('input[name="ctl00$PageContent$loginControl$btnLogin"]');
    logger.info('Clicking login button...');
    await loginButton.click();

    await page.waitForLoadState('networkidle', { timeout: 30000 });
    
    const isLoggedIn = await checkLoginSuccess(page);
    
    if (!isLoggedIn) {
      const errorMessage = await page.locator('.error, .errorMessage, [class*="error"]').first().textContent();
      throw new Error(`Login failed. Possible error: ${errorMessage || 'Unknown error'}`);
    }

    logger.info('Login successful! Extracting cookies...');

    const cookies = await context.cookies();
    logger.info(`Extracted ${cookies.length} cookies`);

    await saveCookiesToCache(cookies);
    logImportantCookies(cookies);

    await browser.close();
    return cookies;
  } catch (error) {
    logger.error('Error during Playwright login:', error);
    await browser.close();
    throw error;
  }
}

/**
 * Check if login was successful
 */
async function checkLoginSuccess(page: any): Promise<boolean> {
  await page.waitForTimeout(1000);

  const currentUrl = page.url();
  const notOnLoginPage = !currentUrl.includes('Login.aspx');

  const hasLogoutLink = await page.locator('text=Logout, text=退出，text=Sign Out').count() > 0;
  const hasWelcomeText = await page.locator('text=Welcome, text=欢迎').count() > 0;

  return notOnLoginPage || hasLogoutLink || hasWelcomeText;
}

/**
 * Log important cookies for debugging
 */
function logImportantCookies(cookies: Cookie[]): void {
  const importantCookieNames = [
    'ASP.NET_SessionId',
    '.ASPXFORMSAUTH',
  ];

  logger.debug('Important cookies:');
  cookies.forEach(cookie => {
    if (importantCookieNames.some(name => cookie.name.includes(name))) {
      logger.debug(`  ${cookie.name}: ${cookie.value.substring(0, 50)}${cookie.value.length > 50 ? '...' : ''}`);
    }
  });
}

/**
 * Load cookies from cache file
 */
export async function loadCachedCookies(): Promise<Cookie[] | null> {
  if (_inMemoryCookies) {
    logger.debug('Using in-memory cached cookies.');
    return _inMemoryCookies;
  }

  if (!fs.existsSync(COOKIE_FILE_PATH)) {
    logger.debug('Cookie cache file not found. No cached cookies loaded.');
    return null;
  }

  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE_PATH, 'utf-8')) as Cookie[];
    _inMemoryCookies = cookies;
    logger.debug(`Loaded ${cookies.length} cookies from file cache.`);
    return cookies;
  } catch (error: any) {
    logger.warn('Error loading cookies from file:', error.message);
    return null;
  }
}

/**
 * Save cookies to cache file
 */
export async function saveCookiesToCache(cookies: Cookie[]): Promise<void> {
  if (!cookies || cookies.length === 0) {
    logger.warn('Attempted to save empty or null cookies. Aborting save.');
    return;
  }

  _inMemoryCookies = cookies;
  
  try {
    await fs.promises.writeFile(COOKIE_FILE_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.debug('Cookies saved to file cache.');
  } catch (error: any) {
    logger.error('Error saving cookies to file:', error.message);
  }
}

/**
 * Backup current cookies before clearing. Restored if re-login fails.
 */
export function backupCookies(): Cookie[] | null {
  if (_inMemoryCookies) {
    _cookieBackup = [..._inMemoryCookies];
    logger.info('Cookies backed up before clear.');
  }
  return _cookieBackup;
}

/**
 * Restore cookies from backup after failed re-login.
 */
export async function restoreCookieBackup(): Promise<boolean> {
  if (_cookieBackup) {
    _inMemoryCookies = _cookieBackup;
    try {
      await fs.promises.writeFile(COOKIE_FILE_PATH, JSON.stringify(_cookieBackup, null, 2), 'utf-8');
      logger.info('Cookies restored from backup successfully.');
      _cookieBackup = null;
      return true;
    } catch (error: any) {
      logger.error('Failed to restore cookies from backup:', error.message);
      return false;
    }
  }
  logger.warn('No cookie backup available for restore.');
  return false;
}

/**
 * Clear cookie cache
 * Prefer backupAndClearCookieCache() instead to preserve old cookies.
 */
export async function clearCookieCache(): Promise<void> {
  _inMemoryCookies = null;
  
  try {
    await fs.promises.unlink(COOKIE_FILE_PATH);
    logger.debug('Cookie cache file deleted.');
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.error('Error deleting cookie file:', error.message);
    } else {
      logger.debug('Cookie cache file did not exist, no need to delete.');
    }
  }
}

/**
 * Convert cookies array to cookie string for axios
 */
export function cookiesToString(cookies: Cookie[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Get cookie string from cache
 */
export async function getCachedCookieString(): Promise<string | null> {
  const cookies = await loadCachedCookies();
  if (!cookies || cookies.length === 0) {
    return null;
  }
  return cookiesToString(cookies);
}
