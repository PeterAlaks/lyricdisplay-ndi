/**
 * Build script for LyricDisplay NDI Native Companion.
 *
 * Produces one platform-specific zip asset expected by LyricDisplay:
 *   lyricdisplay-ndi-win.zip
 *   lyricdisplay-ndi-mac.zip
 *   lyricdisplay-ndi-linux.zip
 *
 * Zip contents are native-only:
 *   lyricdisplay-ndi-native(.exe)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_DIR = path.join(__dirname, 'native');
const DIST_DIR = path.join(__dirname, 'dist');
const STAGE_DIR = path.join(DIST_DIR, 'stage');
const RUNTIME_DIRNAME = 'ndi-runtime';

function platformSuffix() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName() {
  return process.platform === 'win32' ? 'lyricdisplay-ndi-native.exe' : 'lyricdisplay-ndi-native';
}

function runtimeLibraryCandidates() {
  if (process.platform === 'win32') {
    return ['Processing.NDI.Lib.x64.dll'];
  }
  if (process.platform === 'darwin') {
    return ['libndi.dylib'];
  }
  return ['libndi.so.6', 'libndi.so.5', 'libndi.so'];
}

function resolveRuntimeDir() {
  const configured = process.env.NDI_RUNTIME_DIR || process.env.NDILIB_REDIST_FOLDER || '';
  if (!configured) {
    return '';
  }

  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`NDI runtime directory does not exist: ${resolved}`);
  }
  return resolved;
}

function run(command, cwd = __dirname) {
  execSync(command, { cwd, stdio: 'inherit' });
}

function cleanDist() {
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGE_DIR, { recursive: true });
}

function buildNativeBinary() {
  console.log('[1/3] Building native binary (cargo --release)...');
  run('cargo build --release --manifest-path native/Cargo.toml', __dirname);
}

function stageFiles() {
  console.log('[2/3] Staging release files...');
  const compiledBinary = path.join(NATIVE_DIR, 'target', 'release', binaryName());
  if (!fs.existsSync(compiledBinary)) {
    throw new Error(`Compiled binary not found: ${compiledBinary}`);
  }

  const stagedBinary = path.join(STAGE_DIR, binaryName());
  fs.copyFileSync(compiledBinary, stagedBinary);

  const nativeReadme = path.join(NATIVE_DIR, 'README.md');
  const stagedReadme = path.join(STAGE_DIR, 'README.md');
  if (fs.existsSync(nativeReadme)) {
    fs.copyFileSync(nativeReadme, stagedReadme);
  }

  const runtimeDir = resolveRuntimeDir();
  const stagedRuntimeDir = path.join(STAGE_DIR, RUNTIME_DIRNAME);
  const copiedRuntimeLibraries = [];

  if (runtimeDir) {
    fs.mkdirSync(stagedRuntimeDir, { recursive: true });

    for (const library of runtimeLibraryCandidates()) {
      const source = path.join(runtimeDir, library);
      if (!fs.existsSync(source)) {
        continue;
      }

      const destination = path.join(stagedRuntimeDir, library);
      fs.copyFileSync(source, destination);
      copiedRuntimeLibraries.push(library);
    }
  }

  const runtimeManifestPath = path.join(STAGE_DIR, 'ndi-runtime-manifest.json');
  fs.writeFileSync(runtimeManifestPath, `${JSON.stringify({
    platform: process.platform,
    runtimeBundled: copiedRuntimeLibraries.length > 0,
    runtimeDirname: RUNTIME_DIRNAME,
    libraries: copiedRuntimeLibraries
  }, null, 2)}\n`);

  if (runtimeDir && copiedRuntimeLibraries.length === 0) {
    throw new Error(
      `NDI runtime directory provided but no platform libraries were found in ${runtimeDir}.`
    );
  }

  if (copiedRuntimeLibraries.length > 0) {
    console.log(`Staged NDI runtime libraries: ${copiedRuntimeLibraries.join(', ')}`);
  } else {
    console.log('No NDI runtime libraries staged (set NDI_RUNTIME_DIR to bundle runtime)');
  }
}

function createArchive() {
  console.log('[3/3] Creating zip archive...');
  const archiveName = `lyricdisplay-ndi-${platformSuffix()}.zip`;
  const archivePath = path.join(DIST_DIR, archiveName);

  if (process.platform === 'win32') {
    const command = `powershell -Command "Compress-Archive -Path '${STAGE_DIR}\\*' -DestinationPath '${archivePath}' -Force"`;
    run(command, __dirname);
  } else {
    run(`cd "${STAGE_DIR}" && zip -r "${archivePath}" .`, __dirname);
  }

  const sizeMb = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(2);
  console.log(`Build complete: ${archivePath} (${sizeMb} MB)`);
  return archivePath;
}

function main() {
  console.log('LyricDisplay NDI Native Companion Build');
  console.log(`Platform: ${process.platform}`);

  cleanDist();
  buildNativeBinary();
  stageFiles();
  createArchive();
}

main();
