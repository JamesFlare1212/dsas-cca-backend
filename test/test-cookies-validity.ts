import axios from 'axios';

const COOKIE_FILE = './services/cookies.json';

async function testCookies() {
  try {
    const fs = await import('fs');
    if (!fs.existsSync(COOKIE_FILE)) {
      return false;
    }

    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');

    const url = 'https://engage.nkcswx.cn/Services/ActivitiesService.asmx/GetActivityDetails';
    const headers = {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Bun DSAS-CCA)',
    };
    const payload = { "activityID": "3350" };

    await axios.post(url, payload, {
      headers,
      timeout: 10000
    });

    return true;
  } catch (error) {
    return false;
  }
}

const isValid = await testCookies();
process.exit(isValid ? 0 : 1);
