/**
 * Build script for LyricDisplay NDI™ Companion.
 *
 * Uses electron-builder to produce platform-specific .zip archives
 * that the main LyricDisplay app downloads and extracts automatically.
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
  console.log('LyricDisplay NDI Companion — Build');
  console.log(`Platform: ${process.platform} (${process.arch})`);
  console.log('');

  // electron-builder reads the "build" key from package.json.
  // The zip target produces archives that the main app can extract.
  run('npx electron-builder --config package.json');

  console.log('');
  console.log('Build complete. Archives are in dist/');
}

main();
