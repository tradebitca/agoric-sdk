// @ts-check

import '@agoric/install-ses';
import { spawn } from 'child_process';
import { createGzip, createGunzip } from 'zlib';
import { type as osType } from 'os';
import fs from 'fs';
import path from 'path';

import test from 'ava';
import tmp from 'tmp';
import { xsnap } from '@agoric/xsnap';
import bundleSource from '@agoric/bundle-source';
import { makeSnapstore } from '../../src/kernel/vatManager/snapStore';

const empty = new Uint8Array();

/**
 * @param {string} name
 * @param {(request:Uint8Array) => Promise<Uint8Array>} handleCommand
 */
async function bootWorker(name, handleCommand) {
  const worker = xsnap({
    os: osType(),
    spawn,
    handleCommand,
    name,
    stdout: 'inherit',
    stderr: 'inherit',
    // debug: !!env.XSNAP_DEBUG,
  });

  const load = async rel => {
    const b = await bundleSource(require.resolve(rel), 'getExport');
    await worker.evaluate(`(${b.source}\n)()`.trim());
  };
  await load('../../src/kernel/vatManager/lockdown-subprocess-xsnap.js');
  await load('../../src/kernel/vatManager/supervisor-subprocess-xsnap.js');
  return worker;
}

test('build temp file; compress to cache file', async t => {
  const pool = path.resolve(__dirname, './fixture-snap-pool-1/');
  await fs.promises.mkdir(pool, { recursive: true });
  const store = makeSnapstore(pool, {
    ...tmp,
    ...path,
    ...fs,
    ...fs.promises,
  });
  let keepTmp = '';
  let keepDest = '';
  await store.withTempName(async name => {
    keepTmp = name;
    t.falsy(fs.existsSync(name));
    fs.writeFileSync(name, 'abc');
    keepDest = store.resolve('abc.gz');
    await store.filter(name, createGzip(), keepDest);
  });
  t.falsy(
    fs.existsSync(keepTmp),
    'temp file should have been deleted after withTempName',
  );
  t.is(
    path.resolve(pool, 'abc.gz'),
    keepDest,
    'snapStore.resolve works like path.resolve',
  );
  t.truthy(fs.existsSync(keepDest));
  const gz = fs.readFileSync(keepDest);
  t.is(gz.toString('hex'), '1f8b08000000000000034b4c4a0600c241243503000000');
});

test('bootstrap, save, compress', async t => {
  const vat = await bootWorker('test', async _ => empty);
  t.teardown(() => vat.close());

  const pool = path.resolve(__dirname, './fixture-snap-pool-2/');
  await fs.promises.mkdir(pool, { recursive: true });

  const store = makeSnapstore(pool, {
    ...tmp,
    ...path,
    ...fs,
    ...fs.promises,
  });

  await vat.evaluate('globalThis.x = harden({a: 1})');

  /** @type {(fn: string) => number} */
  const Kb = fn => Math.round(fs.statSync(fn).size / 1024);

  const snapSize = {
    raw: 1096,
    compressed: 190,
  };

  let zfile = '';
  await store.withTempName(async snapFile => {
    await vat.snapshot(snapFile);
    t.truthy(
      fs.existsSync(snapFile),
      'When a snapshot is taken, we have xsnap write the snapshot to a temporary file',
    );

    t.is(Kb(snapFile), snapSize.raw, 'raw snapshots are large-ish');

    const h = await store.hash(snapFile);
    t.is(
      h,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'snapshots (and their SHA-512 hashes) are deterministic',
    );
    zfile = store.resolve(`${h}.gz`);
    await store.filter(snapFile, createGzip(), zfile);
  });
  t.is(Kb(zfile), snapSize.compressed, 'compressed snapshots are smaller');
});

test('uncompress, restore, resume', async t => {
  const pool = path.resolve(__dirname, './fixture-snap-pool/');
  await fs.promises.mkdir(pool, { recursive: true });

  const store = makeSnapstore(pool, {
    ...tmp,
    ...path,
    ...fs,
    ...fs.promises,
  });

  const vat0 = await bootWorker('test', async _ => empty);
  t.teardown(() => vat0.close());
  await vat0.evaluate('globalThis.x = harden({a: 1})');
  await store.withTempName(async snapFile => {
    await vat0.snapshot(snapFile);
    const h = await store.hash(snapFile);
    const zfile = store.resolve(`${h}.gz`);
    await store.filter(snapFile, createGzip(), zfile);
  });

  const h = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const worker = await store.withTempName(async raw => {
    await store.filter(store.resolve(`${h}.gz`), createGunzip(), raw);
    return xsnap({ snapshot: raw, os: osType(), spawn });
  });
  t.teardown(() => worker.close());
  worker.evaluate('x.a');
  t.pass();
});
