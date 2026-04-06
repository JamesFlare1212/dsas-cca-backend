import { loginWithPlaywright, saveCookiesToCache } from '../services/playwright-auth';

const username = process.env.API_USERNAME;
const password = process.env.API_PASSWORD;

if (!username || !password) {
  console.error('❌ API_USERNAME and API_PASSWORD environment variables are required');
  process.exit(1);
}

console.log('🔑 Starting cookie extraction...\n');

loginWithPlaywright(username, password)
  .then(cookies => {
    console.log(`\n✅ Extracted ${cookies.length} cookies`);
    console.log('📁 Cookies saved to: ./services/cookies.json');
    
    saveCookiesToCache(cookies);
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Cookie extraction failed:', error);
    process.exit(1);
  });
