/**
 * LyricDisplay NDI Native Companion release helper.
 *
 * Responsibilities:
 * 1. Bump version in native/Cargo.toml and package.json
 * 2. Commit + tag + push
 *
 * Platform assets are built/uploaded by GitHub Actions on tag push.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CARGO_TOML = path.join(ROOT, 'native', 'Cargo.toml');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

function run(command, opts = {}) {
  return execSync(command, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    ...opts
  }).toString().trim();
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseVersionFromCargoToml(content) {
  const match = content.match(/^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m);
  if (!match) {
    throw new Error('Could not find version in native/Cargo.toml');
  }
  return match[1];
}

function updateCargoVersion(content, newVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    throw new Error(`Invalid version format: ${newVersion}`);
  }
  return content.replace(
    /^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m,
    `version = "${newVersion}"`
  );
}

function nextVersions(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`
  };
}

function ensureCleanGit() {
  const status = run('git status --porcelain');
  if (status) {
    throw new Error('Git working directory is not clean');
  }
}

function ensureTagAvailable(tagName) {
  const local = run('git tag -l');
  if (local.split('\n').includes(tagName)) {
    throw new Error(`Tag already exists locally: ${tagName}`);
  }

  const remote = run('git ls-remote --tags origin');
  if (remote.includes(`refs/tags/${tagName}`)) {
    throw new Error(`Tag already exists on origin: ${tagName}`);
  }
}

async function selectVersion(currentVersion) {
  const args = process.argv.slice(2);
  const next = nextVersions(currentVersion);

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--patch') return next.patch;
    if (args[i] === '--minor') return next.minor;
    if (args[i] === '--major') return next.major;
    if (args[i] === '--version' && args[i + 1]) return args[i + 1];
  }

  console.log(`Current version: v${currentVersion}`);
  console.log(`1. Patch -> v${next.patch}`);
  console.log(`2. Minor -> v${next.minor}`);
  console.log(`3. Major -> v${next.major}`);
  console.log('4. Custom');
  console.log('5. Cancel');

  const choice = await prompt('Select (1-5):');
  if (choice === '1') return next.patch;
  if (choice === '2') return next.minor;
  if (choice === '3') return next.major;
  if (choice === '4') return prompt('Enter version (x.y.z):');
  return '';
}

async function main() {
  try {
    ensureCleanGit();
  } catch (error) {
    console.error(`Release blocked: ${error.message}`);
    process.exit(1);
  }

  const cargoContent = fs.readFileSync(CARGO_TOML, 'utf8');
  const currentVersion = parseVersionFromCargoToml(cargoContent);
  const targetVersion = await selectVersion(currentVersion);

  if (!targetVersion) {
    console.log('Release cancelled.');
    process.exit(0);
  }

  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    console.error('Invalid version format. Expected x.y.z');
    process.exit(1);
  }

  const tag = `v${targetVersion}`;

  try {
    ensureTagAvailable(tag);
  } catch (error) {
    console.error(`Release blocked: ${error.message}`);
    process.exit(1);
  }

  const confirm = await prompt(`Release ${tag}? (y/N):`);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Release cancelled.');
    process.exit(0);
  }

  const updatedCargo = updateCargoVersion(cargoContent, targetVersion);
  fs.writeFileSync(CARGO_TOML, updatedCargo);

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  pkg.version = targetVersion;
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

  try {
    run('git add native/Cargo.toml package.json');
    run(`git commit -m "chore: release ${tag}"`, { stdio: 'inherit' });
    run(`git tag ${tag}`);
    run('git push', { stdio: 'inherit' });
    run(`git push origin ${tag}`, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`Release tag pushed: ${tag}`);
  console.log('GitHub Actions will build and publish win/mac/linux zip assets.');
}

main();
