import { binaryInfo, ensureBinary } from 'cloakbrowser';

// Download and verify at build/setup time; never hide a failed browser installation.
await ensureBinary();
const info = binaryInfo();
console.info(
  JSON.stringify({ version: info.version, platform: info.platform, installed: info.installed }),
);
