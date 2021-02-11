// @ts-check

import '@agoric/install-ses';
import { spawn } from 'child_process';
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
  const pool = path.resolve(__dirname, './fixture-snap-pool/');
  await fs.promises.mkdir(pool, { recursive: true });
  const store = makeSnapstore(pool, {
    ...tmp,
    ...path,
    ...fs,
    ...fs.promises,
  });
  let keepTmp = '';
  const hash = await store.save(async fn => {
    t.falsy(fs.existsSync(fn));
    fs.writeFileSync(fn, 'abc');
    keepTmp = fn;
  });
  t.is(
    hash,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  t.falsy(
    fs.existsSync(keepTmp),
    'temp file should have been deleted after withTempName',
  );
  const dest = path.resolve(pool, `${hash}.gz`);
  t.truthy(fs.existsSync(dest));
  const gz = fs.readFileSync(dest);
  t.is(gz.toString('hex'), '1f8b08000000000000034b4c4a0600c241243503000000');
});

test('bootstrap, save, compress', async t => {
  const vat = await bootWorker('test', async _ => empty);
  t.teardown(() => vat.close());

  const pool = path.resolve(__dirname, './fixture-snap-pool/');
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
    compressed: 195,
  };

  const h = await store.save(async snapFile => {
    await vat.snapshot(snapFile);
    t.is(Kb(snapFile), snapSize.raw, 'raw snapshots are large-ish');
  });
  t.is(
    h,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'snapshots (and their SHA-512 hashes) are deterministic',
  );

  const zfile = path.resolve(pool, `${h}.gz`);
  t.truthy(
    Kb(zfile) <= snapSize.compressed,
    'compressed snapshots are smaller',
  );
});

test('create, save, restore, resume', async t => {
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
  const h = await store.save(vat0.snapshot);

  t.is(h, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const worker = await store.load(h, async snapshot => {
    const xs = xsnap({ snapshot, os: osType(), spawn });
    await xs.evaluate('0');
    return xs;
  });
  t.teardown(() => worker.close());
  await worker.evaluate('x.a');
  t.pass();
});
