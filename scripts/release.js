/**
 * LyricDisplay NDI Companion - Release Script
 * 
 * Builds platform-specific zip archives and publishes them as GitHub releases.
 * 
 * Usage:
 *   node scripts/release.js                  # Interactive version bump
 *   node scripts/release.js --version 1.2.0  # Explicit version
 *   node scripts/release.js --patch          # Auto-bump patch
 *   node scripts/release.js --minor          # Auto-bump minor
 *   node scripts/release.js --major          # Auto-bump major
 * 
 * Prerequisites:
 *   - GitHub CLI (gh) installed and authenticated
 *   - Node.js installed
 *   - Run from the lyricdisplay-ndi directory
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ============ Helpers ============

function safeExec(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
    cwd: ROOT,
    ...opts
  }).toString().trim();
}

function log(msg) { console.log(`  ${msg}`); }
function logStep(msg) { console.log(`\n▸ ${msg}`); }
function logSuccess(msg) { console.log(`  ✓ ${msg}`); }
function logError(msg) { console.error(`  ✗ ${msg}`); }

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  ${question} `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getNextVersions(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`
  };
}

function getPlatformSuffix() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function checkGhCli() {
  try {
    safeExec('gh --version');
    safeExec('gh auth status');
    return true;
  } catch {
    return false;
  }
}

function checkTagExists(tagName) {
  try {
    const localTags = safeExec('git tag -l');
    if (localTags.split('\n').includes(tagName)) return 'local';
  } catch { }
  try {
    const remoteTags = safeExec('git ls-remote --tags origin');
    if (remoteTags.includes(`refs/tags/${tagName}`)) return 'remote';
  } catch { }
  return false;
}

// ============ Build ============

function buildDistributable() {
  const distDir = path.join(ROOT, 'dist');
  const buildDir = path.join(distDir, 'lyricdisplay-ndi');

  // Clean
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });

  // Install production dependencies (skip Puppeteer's Chromium download —
  // it will be downloaded on first launch for the correct architecture)
  logStep('Installing production dependencies (without Chromium)...');
  execSync('npm install --production', {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1' }
  });
  logSuccess('Dependencies installed');

  // Install all grandi platform binaries so the zip works on any OS/arch.
  // npm only installs the optionalDependency matching the build machine's platform,
  // so we explicitly install all of them.
  logStep('Installing grandi platform binaries for all targets...');
  const grandiPlatforms = [
    '@grandi/darwin-x64',
    '@grandi/darwin-arm64',
    '@grandi/linux-x64',
    '@grandi/linux-arm64',
    '@grandi/win32-x64',
    '@grandi/win32-ia32'
  ];
  for (const pkg of grandiPlatforms) {
    try {
      execSync(`npm install ${pkg} --no-save`, { stdio: 'pipe', cwd: ROOT, timeout: 60000 });
      log(`Installed ${pkg}`);
    } catch {
      log(`Skipped ${pkg} (not available or failed)`);
    }
  }
  logSuccess('Grandi platform binaries installed');

  // Copy source files
  logStep('Copying files...');
  const srcDir = path.join(ROOT, 'src');
  const destSrcDir = path.join(buildDir, 'src');
  fs.mkdirSync(destSrcDir, { recursive: true });

  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destSrcDir, file));
    log(`Copied src/${file}`);
  }

  // Copy package.json
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(buildDir, 'package.json'));
  log('Copied package.json');

  // Copy node_modules
  log('Copying node_modules (this may take a while)...');
  const srcModules = path.join(ROOT, 'node_modules');
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
        try { fs.symlinkSync(fs.readlinkSync(srcPath), destPath); } catch { fs.copyFileSync(srcPath, destPath); }
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  if (fs.existsSync(srcModules)) {
    copyDirRecursive(srcModules, destModules);
    logSuccess('node_modules copied');
  }

  // Create launcher scripts for all platforms (zip is universal)
  fs.writeFileSync(path.join(buildDir, 'lyricdisplay-ndi.bat'), '@echo off\r\nnode "%~dp0src\\index.js" %*\r\n');
  log('Created lyricdisplay-ndi.bat (Windows)');

  const shellPath = path.join(buildDir, 'lyricdisplay-ndi.sh');
  fs.writeFileSync(shellPath, '#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nnode "$DIR/src/index.js" "$@"\n');
  try { fs.chmodSync(shellPath, '755'); } catch { /* Windows may not support chmod */ }
  log('Created lyricdisplay-ndi.sh (macOS/Linux)');

  return { distDir, buildDir };
}

function createZipArchives(buildDir, distDir, version) {
  // The zip is universal (contains all grandi platform binaries, no Chromium).
  // We create copies with platform-specific names so the download URL in
  // ndiManager.js can resolve the correct asset name for each platform.
  const platformNames = ['win', 'mac', 'linux'];
  const primaryName = `lyricdisplay-ndi-${getPlatformSuffix()}.zip`;
  const primaryPath = path.join(distDir, primaryName);

  logStep(`Creating zip archive: ${primaryName}`);

  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${primaryPath}' -Force"`,
      { stdio: 'inherit', cwd: ROOT }
    );
  } else {
    execSync(`cd "${buildDir}" && zip -r "${primaryPath}" .`, { stdio: 'inherit', cwd: ROOT });
  }

  const stats = fs.statSync(primaryPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  logSuccess(`Archive created: ${primaryPath} (${sizeMB} MB)`);

  // Copy the same zip for other platform names
  const archivePaths = [primaryPath];
  for (const platform of platformNames) {
    const name = `lyricdisplay-ndi-${platform}.zip`;
    const archivePath = path.join(distDir, name);
    if (archivePath !== primaryPath) {
      fs.copyFileSync(primaryPath, archivePath);
      archivePaths.push(archivePath);
      log(`Copied as ${name}`);
    }
  }

  return archivePaths;
}

// ============ Main ============

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  LyricDisplay NDI Companion - Release');
  console.log('═══════════════════════════════════════════\n');

  // Check prerequisites
  if (!checkGhCli()) {
    logError('GitHub CLI (gh) is not installed or not authenticated.');
    log('Install it from https://cli.github.com and run "gh auth login".');
    process.exit(1);
  }

  // Read current version
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;
  const next = getNextVersions(currentVersion);

  log(`Current version: v${currentVersion}`);

  // Determine target version from CLI args
  const args = process.argv.slice(2);
  let targetVersion = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) {
      targetVersion = args[++i];
    } else if (args[i] === '--patch') {
      targetVersion = next.patch;
    } else if (args[i] === '--minor') {
      targetVersion = next.minor;
    } else if (args[i] === '--major') {
      targetVersion = next.major;
    }
  }

  if (!targetVersion) {
    console.log(`\n  Version options:`);
    console.log(`    1) Patch  → v${next.patch}`);
    console.log(`    2) Minor  → v${next.minor}`);
    console.log(`    3) Major  → v${next.major}`);
    console.log(`    4) Custom`);
    console.log(`    5) Cancel\n`);

    const choice = await prompt('Select (1-5):');

    switch (choice) {
      case '1': targetVersion = next.patch; break;
      case '2': targetVersion = next.minor; break;
      case '3': targetVersion = next.major; break;
      case '4':
        targetVersion = await prompt('Enter version (e.g. 1.2.3):');
        if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
          logError('Invalid version format. Use major.minor.patch (e.g. 1.2.3)');
          process.exit(1);
        }
        break;
      default:
        log('Release cancelled.');
        process.exit(0);
    }
  }

  const tagName = `v${targetVersion}`;
  log(`Target version: ${tagName}`);

  // Check for tag conflicts
  const conflict = checkTagExists(tagName);
  if (conflict) {
    logError(`Tag ${tagName} already exists (${conflict}). Choose a different version.`);
    process.exit(1);
  }

  // Check git status
  try {
    const status = safeExec('git status --porcelain');
    if (status) {
      logError('Git working directory is not clean. Commit or stash changes first.');
      process.exit(1);
    }
  } catch {
    logError('Not a valid git repository or git not found.');
    process.exit(1);
  }

  // Confirm
  const confirm = await prompt(`Release ${tagName}? (y/N):`);
  if (confirm.toLowerCase() !== 'y') {
    log('Release cancelled.');
    process.exit(0);
  }

  try {
    // Step 1: Update version in package.json
    logStep(`Updating version to ${targetVersion}...`);
    pkg.version = targetVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    logSuccess(`package.json updated to ${targetVersion}`);

    // Step 2: Build
    logStep('Building distributable...');
    const { distDir, buildDir } = buildDistributable();

    // Step 3: Create zips (universal zip copied with platform-specific names)
    const archivePaths = createZipArchives(buildDir, distDir, targetVersion);

    // Step 4: Commit and tag
    logStep('Committing and tagging...');
    safeExec('git add package.json package-lock.json');
    safeExec(`git commit -m "chore: release ${tagName}"`);
    safeExec(`git tag ${tagName}`);
    logSuccess('Commit and tag created');

    // Step 5: Push
    logStep('Pushing to GitHub...');
    safeExec('git push');
    safeExec(`git push origin ${tagName}`);
    logSuccess('Pushed to origin');

    // Step 6: Create GitHub release with all platform zips as assets
    logStep('Creating GitHub release...');

    const releaseTitle = `LyricDisplay NDI Companion ${tagName}`;
    const releaseNotes = `NDI Companion ${tagName} for LyricDisplay.\n\nThe zip is universal — it works on Windows, macOS (Intel & Apple Silicon), and Linux.\nChromium (for headless rendering) is downloaded automatically on first launch.\n\nYou can also let LyricDisplay download it automatically from Preferences → NDI Broadcasting.`;

    // Build the gh release create command with all assets
    const assetArgs = archivePaths.map(p => `"${p}"`).join(' ');

    try {
      safeExec(
        `gh release create ${tagName} ${assetArgs} --title "${releaseTitle}" --notes "${releaseNotes}"`,
        { timeout: 180000 }
      );
      logSuccess(`GitHub release created with ${archivePaths.length} assets: ${tagName}`);
    } catch (err) {
      // Release might already exist, try uploading assets individually
      log('Release may already exist, uploading assets...');
      for (const archivePath of archivePaths) {
        try {
          safeExec(
            `gh release upload ${tagName} "${archivePath}" --clobber`,
            { timeout: 120000 }
          );
          logSuccess(`Uploaded ${path.basename(archivePath)}`);
        } catch (uploadErr) {
          logError(`Failed to upload ${path.basename(archivePath)}: ${uploadErr.message}`);
        }
      }
    }

    console.log('\n═══════════════════════════════════════════');
    console.log(`  ✓ Release ${tagName} complete!`);
    console.log(`  https://github.com/PeterAlaks/lyricdisplay-ndi/releases/tag/${tagName}`);
    console.log('═══════════════════════════════════════════\n');

    log('All platform zips uploaded (universal build).');
    log('No need to run on other machines — the zip works everywhere.');

  } catch (error) {
    logError(`Release failed: ${error.message}`);
    log('Your local files may be modified. Run "git reset --hard HEAD" to clean up.');
    process.exit(1);
  }
}

main();
