#!/bin/sh
set -e

echo "🚀 Starting DSAS CCA Backend..."

# Check if cookies exist and are valid
if [ -f /usr/src/app/services/cookies.json ]; then
  echo "📁 Cookies file found. Checking validity..."
  
  # Try to fetch a simple activity to test cookies
  # If it fails, we'll get fresh cookies
  if ! timeout 10 bun run test/test-cookies-validity.ts 2>/dev/null; then
    echo "⚠️ Cookies are invalid or expired. Getting fresh cookies..."
    bun run test/get-cookies.ts
  else
    echo "✅ Cookies are valid. Using cached cookies."
  fi
else
  echo "📁 No cookies file found. Getting fresh cookies..."
  bun run test/get-cookies.ts
fi

# Start the application
echo "🎯 Starting application..."
exec bun run index.ts
