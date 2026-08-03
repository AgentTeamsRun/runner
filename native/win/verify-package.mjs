import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const verifyPackage = async (packageRoot, requestedVersion) => {
  const nativeDir = join(packageRoot, 'native', 'bin', 'win32-x64');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  // Default to the package's own version so `prepublishOnly` can enforce the
  // contract without threading the version through the npm lifecycle.
  const expectedVersion = requestedVersion ?? packageJson.version;
  const manifest = JSON.parse(await readFile(join(nativeDir, 'manifest.json'), 'utf8'));
  const binary = await readFile(join(nativeDir, manifest.fileName));
  const actualHash = createHash('sha256').update(binary).digest('hex');

  if (
    !expectedVersion ||
    packageJson.version !== expectedVersion ||
    manifest.schemaVersion !== 1 ||
    manifest.version !== expectedVersion ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    manifest.fileName !== 'agentrunner-launcher.exe' ||
    manifest.sha256 !== actualHash
  ) {
    throw new Error(
      `Windows launcher package verification failed: expected=${expectedVersion}, ` +
        `package=${packageJson.version}, manifest=${manifest.version}, ` +
        `schemaVersion=${manifest.schemaVersion}, hash=${actualHash}`,
    );
  }

  // The artifact directory is shipped verbatim via package.json `files`, so any
  // stray build or smoke leftover would end up inside the published tarball.
  const allowedEntries = new Set(['agentrunner-launcher.exe', 'manifest.json']);
  const unexpectedEntries = (await readdir(nativeDir)).filter((entry) => !allowedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    throw new Error(`Windows launcher artifact directory contains unexpected files: ${unexpectedEntries.join(', ')}`);
  }

  return { expectedVersion, actualHash };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyPackage(process.argv[2] ?? process.cwd(), process.argv[3]);
  process.stdout.write(`Verified Windows launcher ${result.expectedVersion} (${result.actualHash.slice(0, 12)}).\n`);
}
