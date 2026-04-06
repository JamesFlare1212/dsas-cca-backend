import { test, expect } from 'bun:test';
import { chromium, type Cookie } from 'playwright';
import * as fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COOKIE_FILE_PATH = resolve(__dirname, '../services/cookies.json');

const testUsername = process.env.API_USERNAME || 'test@test.com';
const testPassword = process.env.API_PASSWORD || 'test123';

test('should login and extract cookies successfully', async () => {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    
    await page.goto('https://engage.nkcswx.cn/Login.aspx', { 
      waitUntil: 'networkidle',
      timeout: 60000
    });

    const usernameField = page.locator('input[name="ctl00$PageContent$loginControl$txtUN"]');
    await usernameField.fill(decodeURIComponent(testUsername));

    const passwordField = page.locator('input[name="ctl00$PageContent$loginControl$txtPwd"]');
    await passwordField.fill(decodeURIComponent(testPassword));

    const loginButton = page.locator('input[name="ctl00$PageContent$loginControl$btnLogin"]');
    await loginButton.click();

    await page.waitForLoadState('networkidle', { timeout: 60000 });

    const cookies = await context.cookies();
    
    expect(cookies).toBeDefined();
    expect(cookies.length).toBeGreaterThan(0);
    
    const hasSessionCookie = cookies.some(c => c.name === 'ASP.NET_SessionId');
    expect(hasSessionCookie).toBe(true);

    fs.writeFileSync(COOKIE_FILE_PATH, JSON.stringify(cookies, null, 2));
  } finally {
    await browser.close();
  }
}, 120000);

test('should load cookies from file if exists', () => {
  if (!fs.existsSync(COOKIE_FILE_PATH)) {
    throw new Error('Cookie file does not exist');
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE_PATH, 'utf-8')) as Cookie[];
  expect(cookies.length).toBeGreaterThan(0);
});

test('should test cookie validity', async () => {
  if (!fs.existsSync(COOKIE_FILE_PATH)) {
    throw new Error('Cookie file does not exist');
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE_PATH, 'utf-8')) as Cookie[];
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    
    const page = await context.newPage();
    
    await page.goto('https://engage.nkcswx.cn/', { 
      waitUntil: 'networkidle',
      timeout: 30000
    });

    const url = page.url();
    const isRedirectedToLogin = url.includes('/Login.aspx');
    
    expect(isRedirectedToLogin).toBe(false);
  } finally {
    await browser.close();
  }
}, 60000);

test('should convert cookies to string format', () => {
  if (!fs.existsSync(COOKIE_FILE_PATH)) {
    throw new Error('Cookie file does not exist');
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE_PATH, 'utf-8')) as Cookie[];
  
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  expect(cookieString).toBeDefined();
  expect(cookieString.length).toBeGreaterThan(0);
  expect(cookieString).toContain('ASP.NET_SessionId=');
});

test('should clear cookie cache', () => {
  if (fs.existsSync(COOKIE_FILE_PATH)) {
    fs.unlinkSync(COOKIE_FILE_PATH);
  }
  
  const exists = fs.existsSync(COOKIE_FILE_PATH);
  expect(exists).toBe(false);
});
