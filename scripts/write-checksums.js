import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', 'dist');
const archives = fs.readdirSync(distDir).filter((name) => name.endsWith('.zip'));
if (archives.length === 0) throw new Error('No release archives found in dist');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

for (const archive of archives) {
  const archivePath = path.join(distDir, archive);
  const digest = await hashFile(archivePath);
  fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${archive}\n`);
  console.log(`Wrote ${archive}.sha256`);
}
