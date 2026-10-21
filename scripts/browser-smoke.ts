import { launch } from 'cloakbrowser';

const browser = await launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('data:text/html,<title>DSAS%20browser%20smoke</title><p>ready</p>', {
    waitUntil: 'domcontentloaded',
    timeout: 10000,
  });
  if (
    (await page.title()) !== 'DSAS browser smoke' ||
    (await page.locator('p').textContent()) !== 'ready'
  )
    throw new Error('CloakBrowser smoke test failed');
  console.info('CloakBrowser launched and rendered a page successfully.');
} finally {
  await browser.close();
}
