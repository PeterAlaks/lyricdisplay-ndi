/**
 * Build script for LyricDisplay NDI Companion
 * 
 * Since the companion uses Puppeteer (which bundles Chromium), we can't use `pkg`
 * to create a single binary. Instead, we create a distributable zip containing:
 * - src/ (the companion source files)
 * - node_modules/ (all dependencies including Puppeteer's Chromium)
 * - package.json
 * - A launcher script/batch file
 * 
 * The main LyricDisplay app downloads and extracts this zip, then spawns
 * `node src/index.js` with the appropriate arguments.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, 'dist');
const platform = process.platform;

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

console.log('Building LyricDisplay NDI Companion...');
console.log(`Platform: ${platform}`);

// Step 1: Install production dependencies
console.log('\n[1/3] Installing production dependencies...');
execSync('npm install --production', {
  stdio: 'inherit',
  cwd: __dirname
});

// Step 2: Create the distributable directory structure
const buildDir = path.join(distDir, 'lyricdisplay-ndi');
if (fs.existsSync(buildDir)) {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
fs.mkdirSync(buildDir, { recursive: true });

console.log('\n[2/3] Copying files...');

// Copy source files
const srcDir = path.join(__dirname, 'src');
const destSrcDir = path.join(buildDir, 'src');
fs.mkdirSync(destSrcDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destSrcDir, file));
  console.log(`  Copied src/${file}`);
}

// Copy package.json
fs.copyFileSync(
  path.join(__dirname, 'package.json'),
  path.join(buildDir, 'package.json')
);
console.log('  Copied package.json');

// Copy node_modules
console.log('  Copying node_modules (this may take a while)...');
const srcModules = path.join(__dirname, 'node_modules');
const destModules = path.join(buildDir, 'node_modules');

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      try { fs.symlinkSync(target, destPath); } catch { fs.copyFileSync(srcPath, destPath); }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(srcModules)) {
  copyDirRecursive(srcModules, destModules);
  console.log('  node_modules copied');
}

// Create launcher scripts
if (platform === 'win32') {
  const batchContent = `@echo off\r\nnode "%~dp0src\\index.js" %*\r\n`;
  fs.writeFileSync(path.join(buildDir, 'lyricdisplay-ndi.bat'), batchContent);
  console.log('  Created lyricdisplay-ndi.bat');
} else {
  const shellContent = `#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nnode "$DIR/src/index.js" "$@"\n`;
  const shellPath = path.join(buildDir, 'lyricdisplay-ndi');
  fs.writeFileSync(shellPath, shellContent);
  fs.chmodSync(shellPath, '755');
  console.log('  Created lyricdisplay-ndi launcher');
}

// Step 3: Create zip archive
console.log('\n[3/3] Creating zip archive...');

const archiveName = `lyricdisplay-ndi-${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}.zip`;
const archivePath = path.join(distDir, archiveName);

try {
  // Use system zip if available, otherwise report manual step needed
  if (platform === 'win32') {
    execSync(`powershell -Command "Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${archivePath}' -Force"`, {
      stdio: 'inherit'
    });
  } else {
    // Use -j flag equivalent: cd into the build dir so paths are relative (no parent folder in zip)
    execSync(`cd "${buildDir}" && zip -r "${archivePath}" .`, {
      stdio: 'inherit'
    });
  }

  const stats = fs.statSync(archivePath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  console.log(`\nBuild complete!`);
  console.log(`Archive: ${archivePath}`);
  console.log(`Size: ${sizeMB} MB`);
} catch (error) {
  console.warn('\nZip creation failed:', error.message);
  console.log(`Build directory ready at: ${buildDir}`);
  console.log('Please create the zip archive manually.');
}
