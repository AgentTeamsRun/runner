import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { verifyPackage } from './verify-package.mjs';
import { verifyPackedPackage } from './verify-packed-package.mjs';

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentrunner-package-contract-'));
  const nativeDir = join(root, 'native', 'bin', 'win32-x64');
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'agentrunner-contract-fixture', version: '1.2.3' }),
  );
  await writeFile(join(nativeDir, 'agentrunner-launcher.exe'), 'fixture-binary');
  await writeFile(
    join(nativeDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.2.3',
      platform: 'win32',
      arch: 'x64',
      fileName: 'agentrunner-launcher.exe',
      sha256: '74dd6752f5b83360c8fb780f06d74e5edb2712ea55a59b02a263584b091993a4',
    }),
  );
  return { root, nativeDir };
};

describe('verifyPackage', () => {
  it('accepts a matching package contract', async () => {
    const fixture = await createFixture();
    try {
      await verifyPackage(fixture.root, '1.2.3');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('verifies the source and npm tarball extraction through the same entrypoint', async () => {
    const fixture = await createFixture();
    try {
      const result = await verifyPackedPackage(fixture.root, '1.2.3');
      assert.equal(result.expectedVersion, '1.2.3');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects package version, hash, and BOM-prefixed JSON fixtures', async () => {
    for (const kind of ['version', 'hash', 'bom']) {
      const fixture = await createFixture();
      try {
        const manifestPath = join(fixture.nativeDir, 'manifest.json');
        if (kind === 'version') {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          manifest.version = '9.9.9';
          await writeFile(manifestPath, JSON.stringify(manifest));
        } else if (kind === 'hash') {
          await writeFile(join(fixture.nativeDir, 'agentrunner-launcher.exe'), 'tampered');
        } else {
          const manifest = await readFile(manifestPath, 'utf8');
          await writeFile(manifestPath, `\ufeff${manifest}`);
        }
        await assert.rejects(verifyPackage(fixture.root, '1.2.3'));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
});
