import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyPackage } from './verify-package.mjs';

export const verifyPackedPackage = async (packageRoot, expectedVersion) => {
  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useBundledNpmCli = process.platform === 'win32' && existsSync(bundledNpmCli);
  if (process.platform === 'win32' && !useBundledNpmCli) {
    throw new Error(`Bundled npm CLI was not found next to Node.js: ${bundledNpmCli}`);
  }
  const workDir = await mkdtemp(join(tmpdir(), 'agentrunner-packed-contract-'));
  const npmCommand = useBundledNpmCli ? process.execPath : 'npm';
  const npmPrefixArguments = useBundledNpmCli ? [bundledNpmCli] : [];
  const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';

  try {
    const source = await verifyPackage(packageRoot, expectedVersion);
    const packOutput = execFileSync(
      npmCommand,
      [...npmPrefixArguments, 'pack', '--json', '--silent', '--ignore-scripts', '--pack-destination', workDir],
      {
        cwd: packageRoot,
        encoding: 'utf8',
      },
    );
    const pack = JSON.parse(packOutput);
    const tarball = join(workDir, pack[0].filename);
    execFileSync(tarCommand, ['-xf', tarball, '-C', workDir], { stdio: 'pipe' });
    const unpacked = await verifyPackage(join(workDir, 'package'), source.expectedVersion);
    if (source.actualHash !== unpacked.actualHash) {
      throw new Error(
        `Source and unpacked tarball launcher hashes differ: source=${source.actualHash}, packed=${unpacked.actualHash}`,
      );
    }
    return source;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyPackedPackage(process.argv[2] ?? process.cwd(), process.argv[3]);
  process.stdout.write(
    `Verified source and unpacked Windows launcher ${result.expectedVersion} (${result.actualHash.slice(0, 12)}).\n`,
  );
}
