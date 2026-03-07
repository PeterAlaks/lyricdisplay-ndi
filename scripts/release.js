/**
 * LyricDisplay NDI™ Companion — Release Assistant
 *
 * Mirrors the main app's release workflow:
 *   1. Verify clean git state and GitHub CLI auth
 *   2. Prompt for version bump
 *   3. Optionally collect release notes
 *   4. Bump package.json, commit, tag, push
 *   5. Poll GitHub Actions until the CI build completes
 *
 * Platform archives (.zip) are built and uploaded by the
 * release.yml workflow that triggers on the pushed v* tag.
 *
 * Usage:
 *   node scripts/release.js
 *   node scripts/release.js --patch
 *   node scripts/release.js --minor
 *   node scripts/release.js --major
 *   node scripts/release.js --version 1.2.3
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const GITHUB_OWNER = 'PeterAlaks';
const GITHUB_REPO = 'lyricdisplay-ndi';
const WORKFLOW_FILE = 'release.yml';

// ─── Helpers ───���────────────────────────────────────────────

function safeExec(cmd, opts = {}) {
  const result = execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30000,
    ...opts,
  });
  // When stdio is 'inherit', execSync returns null (output goes to terminal).
  if (result == null) return '';
  return result.toString().trim();
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNextVersions(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

// ─── Precondition Checks ────────────────────────────────────

function checkGhCli() {
  try {
    safeExec('gh --version');
    safeExec('gh auth status');
    return true;
  } catch {
    return false;
  }
}

function ensureCleanGit() {
  const status = safeExec('git status --porcelain');
  if (status) {
    console.error('\n  ERROR: Git working directory is not clean.');
    console.error('  Please commit or stash all changes before releasing.\n');
    process.exit(1);
  }
}

function checkTagExists(tagName) {
  try {
    const localTags = safeExec('git tag -l');
    if (localTags.split('\n').includes(tagName)) return 'local';
  } catch { /* ignore */ }

  try {
    const remoteTags = safeExec('git ls-remote --tags origin');
    if (remoteTags.includes(`refs/tags/${tagName}`)) return 'remote';
  } catch {
    console.log('  Warning: Could not check remote tags (connection issue?)');
  }
  return false;
}

// ─── Version Selection ──────────────────────────────────────

async function selectVersion(currentVersion) {
  const args = process.argv.slice(2);
  const next = getNextVersions(currentVersion);

  // CLI shorthand flags
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch') return next.patch;
    if (args[i] === '--minor') return next.minor;
    if (args[i] === '--major') return next.major;
    if (args[i] === '--version' && args[i + 1]) return args[i + 1];
  }

  // Interactive menu
  console.log(`  Current version: v${currentVersion}\n`);
  console.log(`  1. Patch  ->  v${next.patch}`);
  console.log(`  2. Minor  ->  v${next.minor}`);
  console.log(`  3. Major  ->  v${next.major}`);
  console.log('  4. Custom');
  console.log('  5. Cancel\n');

  const choice = await prompt('  Select (1-5): ');
  if (choice === '1') return next.patch;
  if (choice === '2') return next.minor;
  if (choice === '3') return next.major;
  if (choice === '4') {
    const custom = await prompt('  Enter version (x.y.z): ');
    return custom;
  }
  return '';
}

// ─── Release Notes ──────────────────────────────────────────

async function collectReleaseNotes() {
  console.log('\n  Release Notes');
  console.log('  1. Type inline (single line)');
  console.log('  2. Use external editor (multi-line)');
  console.log('  3. Skip (no release notes)\n');

  const choice = await prompt('  Select (1-3): ');

  if (choice === '1') {
    return await prompt('  Release notes: ');
  }

  if (choice === '2') {
    const tempFile = path.join(ROOT, '.release-notes-temp.txt');
    const template = [
      '# Enter your release notes below',
      '# Lines starting with # will be ignored',
      '# Save and close this file when done',
      '',
      '',
    ].join('\n');

    try {
      fs.writeFileSync(tempFile, template);
      const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'nano');
      execSync(`${editor} ${tempFile}`, { cwd: ROOT, stdio: 'inherit' });

      const content = fs.readFileSync(tempFile, 'utf8');
      const notes = content
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
        .trim();

      fs.unlinkSync(tempFile);

      if (notes) {
        console.log('\n  Release notes captured:');
        console.log('  ' + '-'.repeat(48));
        notes.split('\n').forEach((l) => console.log(`  ${l}`));
        console.log('  ' + '-'.repeat(48));

        const ok = await prompt('\n  Use these release notes? (y/N): ');
        if (ok.toLowerCase() === 'y') return notes;
        console.log('  Release notes discarded.');
      }
    } catch {
      console.log('  Failed to open editor. Skipping release notes.');
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  return '';
}

// ─── CI Polling ─────────────────────────────────────────────

async function waitForGitHubActions(tagName) {
  console.log('\n  Waiting for GitHub Actions to complete...');
  console.log(`  Tracking tag: ${tagName} (polling every 30s)\n`);

  const maxAttempts = 60; // 30 minutes
  let attempts = 0;

  // gh run list filters by workflow file; we look for runs triggered by the tag push.
  const listCmd = `gh run list --repo ${GITHUB_OWNER}/${GITHUB_REPO} --workflow=${WORKFLOW_FILE} --json conclusion,status,headBranch --limit 5`;

  while (attempts < maxAttempts) {
    try {
      const runs = JSON.parse(safeExec(listCmd));
      // Find the run triggered by our tag.
      const run = runs.find((r) => r.headBranch === tagName);

      if (run) {
        if (run.conclusion === 'success') {
          console.log('\n  GitHub Actions build completed successfully!');
          return true;
        }
        if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
          console.error('\n  GitHub Actions build failed or was cancelled!');
          console.error(`  Check: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`);
          return false;
        }
        // Still in progress
        process.stdout.write('.');
      } else {
        // Run not yet visible
        if (attempts === 0) {
          console.log('  Workflow run not yet visible. Waiting for GitHub to register...');
        }
        process.stdout.write('.');
      }
    } catch {
      process.stdout.write('?');
    }

    attempts++;
    await sleep(30000);
  }

  console.error('\n  Timed out waiting for GitHub Actions (30 min).');
  console.error(`  Check manually: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions`);
  return false;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('\n  LyricDisplay NDI Companion — Release Assistant\n');

  // 1. Preconditions
  if (!checkGhCli()) {
    console.error('  ERROR: GitHub CLI (gh) is not installed or not authenticated.');
    console.error('  Install it from https://cli.github.com and run "gh auth login".\n');
    process.exit(1);
  }

  ensureCleanGit();

  // 2. Version selection
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const currentVersion = pkg.version;
  const targetVersion = await selectVersion(currentVersion);

  if (!targetVersion) {
    console.log('  Release cancelled.\n');
    process.exit(0);
  }
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    console.error('  Invalid version format. Expected x.y.z\n');
    process.exit(1);
  }

  const tag = `v${targetVersion}`;

  if (targetVersion === currentVersion) {
    console.error(`\n  ERROR: Target version (${targetVersion}) is the same as the current version.`);
    console.error('  Choose a different version to release.\n');
    process.exit(1);
  }

  const conflict = checkTagExists(tag);
  if (conflict) {
    console.error(`\n  ERROR: Tag ${tag} already exists (${conflict}).`);
    console.error('  Delete the tag or choose a different version.\n');
    process.exit(1);
  }

  // 3. Release notes
  const notes = await collectReleaseNotes();

  // 4. Confirm
  const confirm = await prompt(`\n  Release ${tag}? (y/N): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('  Release cancelled.\n');
    process.exit(0);
  }

  // 5. Bump, commit, tag, push
  console.log(`\n  Starting release ${tag}...`);

  try {
    // Bump version in package.json
    pkg.version = targetVersion;
    fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

    // Also bump version in package-lock.json if it exists
    const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
    if (fs.existsSync(PACKAGE_LOCK)) {
      try {
        const lock = JSON.parse(fs.readFileSync(PACKAGE_LOCK, 'utf8'));
        lock.version = targetVersion;
        if (lock.packages && lock.packages['']) {
          lock.packages[''].version = targetVersion;
        }
        fs.writeFileSync(PACKAGE_LOCK, `${JSON.stringify(lock, null, 2)}\n`);
      } catch (lockErr) {
        console.warn('  Warning: Could not update package-lock.json:', lockErr.message);
      }
    }

    // Commit
    safeExec('git add package.json package-lock.json');

    let commitMsg = `chore: release ${tag}`;
    if (notes) {
      commitMsg += `\n\n${notes}`;
    }

    const commitMsgFile = path.join(ROOT, '.commit-msg-temp.txt');
    fs.writeFileSync(commitMsgFile, commitMsg);
    try {
      safeExec(`git commit -F "${commitMsgFile}"`, { stdio: 'inherit' });
    } finally {
      if (fs.existsSync(commitMsgFile)) fs.unlinkSync(commitMsgFile);
    }

    // Tag
    if (notes) {
      const tagMsgFile = path.join(ROOT, '.tag-msg-temp.txt');
      fs.writeFileSync(tagMsgFile, notes);
      try {
        safeExec(`git tag -a ${tag} -F "${tagMsgFile}"`);
      } finally {
        if (fs.existsSync(tagMsgFile)) fs.unlinkSync(tagMsgFile);
      }
    } else {
      safeExec(`git tag ${tag}`);
    }

    console.log('  Commit and tag created locally.');

    // Push
    console.log('  Pushing to GitHub...');
    safeExec('git push', { stdio: 'inherit' });
    safeExec(`git push origin ${tag}`, { stdio: 'inherit' });
    console.log('  Commit and tag pushed to origin.');
  } catch (error) {
    console.error(`\n  RELEASE FAILED: ${error.message}`);
    console.error('  Your local files may be modified. Run "git reset --hard HEAD" to clean up.\n');
    process.exit(1);
  }

  // 6. Wait for CI
  const ciSuccess = await waitForGitHubActions(tag);

  if (!ciSuccess) {
    console.error(`\n  CI FAILED. The tag ${tag} exists on GitHub but builds did not succeed.`);
    console.error(`  Check: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions\n`);
    process.exit(1);
  }

  // 7. Done
  console.log('\n  Release complete!');
  console.log(`  Tag:     ${tag}`);
  console.log(`  Release: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}`);
  console.log('  GitHub Actions built and uploaded platform archives (win, mac-x64, mac-arm64, linux).\n');
}

main();
