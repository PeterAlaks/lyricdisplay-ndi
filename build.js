/**
 * Build script for LyricDisplay NDI™ Companion.
 *
 * Uses electron-builder to produce platform-specific .zip archives
 * that the main LyricDisplay app downloads and extracts automatically.
 *
 * Usage:
 *   node build.js                  Build for the current platform and arch
 *   node build.js --win --x64      Build for Windows x64
 *   node build.js --mac --arm64    Build for macOS arm64
 *   node build.js --linux --x64    Build for Linux x64
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(command) {
  execSync(command, { cwd: __dirname, stdio: 'inherit' });
}

function main() {
  // Forward any CLI arguments (e.g. --win --x64) to electron-builder.
  const extraArgs = process.argv.slice(2).join(' ');

  console.log('LyricDisplay NDI Companion — Build');
  console.log(`Platform: ${process.platform} (${process.arch})`);
  if (extraArgs) {
    console.log(`Extra args: ${extraArgs}`);
  }
  console.log('');

  // electron-builder reads the "build" key from package.json.
  // The zip target produces archives that the main app can extract.
  // --publish never prevents electron-builder from trying to publish
  // (release asset upload is handled separately by the CI workflow).
  const cmd = `npx electron-builder ${extraArgs} --publish never`.trim();
  run(cmd);

  console.log('');
  console.log('Build complete. Archives are in dist/');
}

main();
