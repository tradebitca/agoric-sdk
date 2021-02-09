// @ts-check
import '@agoric/install-ses';
import test from 'ava';
import { assert, q, details as d } from '@agoric/assert';
import { initSwingStore } from '@agoric/swing-store-simple';
import bundleSource from '@agoric/bundle-source';
import { Remotable, getInterfaceOf } from '@agoric/marshal';

import { makeXsSubprocessFactory } from '../../src/kernel/vatManager/manager-subprocess-xsnap';
import makeKernelKeeper from '../../src/kernel/state/kernelKeeper';
import { wrapStorage } from '../../src/kernel/state/storageWrapper';

import { loadBasedir } from '../../src';
import { makeStartXSnap } from '../../src/controller';
import { makeVatTranslators } from '../../src/kernel/vatTranslator';

/**
 * @param { ReturnType<typeof makeKernelKeeper> } kernelKeeper
 * @param { SwingStore['storage'] } storage
 * @param { Record<string, VatManagerFactory> } factories
 * @param { (vatID: string, translators: unknown) => VatSyscallHandler } buildVatSyscallHandler
 * @param {{ sizeHint?: number }=} policyOptions
 *
 * @typedef { import('../../src/kernel/vatManager/manager-subprocess-xsnap').VatManagerFactory } VatManagerFactory
 * @typedef { {
 *   replayTranscript: () => Promise<void>,
 *   setVatSyscallHandler: (handler: VatSyscallHandler) => void,
 *   deliver: (d: Tagged) => Promise<Tagged>,
 *   shutdown: () => Promise<void>,
 * } } VatManager
 *
 * @typedef { ReturnType<typeof initSwingStore> } SwingStore
 * @typedef {(syscall: Tagged) => ['error', string] | ['ok', null] | ['ok', Capdata]} VatSyscallHandler
 * @typedef {{ body: string, slots: unknown[] }} Capdata
 * @typedef { [unknown, ...unknown[]] } Tagged
 * @typedef { { moduleFormat: string }} Bundle
 */
export function makeVatWarehouse(
  kernelKeeper,
  storage,
  factories,
  buildVatSyscallHandler,
  policyOptions,
) {
  const { sizeHint = 10 } = policyOptions || {};
  /** @type { Map<string, VatManager> } */
  const idToManager = new Map();

  const { parse, stringify } = JSON;

  // v$NN.source = JSON({ bundle }) or JSON({ bundleName })
  // v$NN.options = JSON
  // TODO: check against createVatDynamically
  // TODO transaction boundaries?
  // ensure kernel doesn't start transaction until after it gets manager?
  const idToInitDetail = {
    /** @type { (vatID: string) => { vatID: string, bundle: Bundle, options: ManagerOptions } } */
    get(vatID) {
      const { bundle } = parse(storage.get(`${vatID}.source`));
      assert(bundle, d`${q(vatID)}: bundleName not supported`);

      const options = parse(storage.get(`${vatID}.options`));
      // TODO: validate options

      return { vatID, bundle, options };
    },
    /** @type { (vatID: string, d: { bundle: Bundle, options: ManagerOptions }) => void } */
    set(vatID, { options, bundle }) {
      storage.set(`${vatID}.source`, stringify({ bundle }));
      storage.set(`${vatID}.options`, stringify(options));
    },
    has(/** @type { unknown } */ vatID) {
      return storage.has(`${vatID}.source`) && storage.has(`${vatID}.options`);
    },
  };

  /**
   * @param {string} vatID
   * @param {Bundle} bundle
   * @param {ManagerOptions} options
   */
  function initVatManager(vatID, bundle, options) {
    assert(
      !idToInitDetail.has(vatID),
      d`vat with id ${vatID} already initialized`,
    );
    const { managerType } = options;
    assert(managerType in factories, d`unknown managerType ${managerType}`);

    idToInitDetail.set(vatID, { bundle, options });

    // TODO: add a way to remove a gatekeeper from ephemeral in kernel.js
    // so that we can get rid of a vatKeeper when we evict its vat.
    kernelKeeper.allocateVatKeeper(vatID);
  }

  /**
   * @param {string} vatID
   * @returns { Promise<VatManager> }
   */
  async function provideVatManager(vatID) {
    const mgr = idToManager.get(vatID);
    if (mgr) return mgr;
    const detail = idToInitDetail.get(vatID);
    assert(detail, d`no vat with ID ${vatID} initialized`);

    // TODO: move kernelKeeper.allocateVatKeeper(vatID);
    // to here

    // TODO: load from snapshot

    const { bundle, options } = detail;
    const { managerType } = options;
    console.log('provide: creating from bundle', vatID);
    const manager = await factories[managerType].createFromBundle(
      vatID,
      bundle,
      options,
    );

    const translators = makeVatTranslators(vatID, kernelKeeper);

    const vatSyscallHandler = buildVatSyscallHandler(vatID, translators);
    manager.setVatSyscallHandler(vatSyscallHandler);
    await manager.replayTranscript();
    idToManager.set(vatID, manager);
    return manager;
  }

  /** @type { (vatID: string) => Promise<void> } */
  async function evict(vatID) {
    assert(idToInitDetail.has(vatID), d`no vat with ID ${vatID} initialized`);
    const mgr = idToManager.get(vatID);
    if (!mgr) return;
    idToManager.delete(vatID);
    console.log('evict: shutting down', vatID);
    await mgr.shutdown();
  }

  /** @type { string[] } */
  const recent = [];

  /**
   * Simple fixed-size LRU cache policy
   *
   * TODO: policy input: did a vat get a message? how long ago?
   * "important" vat option?
   * options: pay $/block to keep in RAM - advisory; not consensus
   * creation arg: # of vats to keep in RAM (LRU 10~50~100)
   *
   * @param {string} currentVatID
   */
  async function applyAvailabilityPolicy(currentVatID) {
    // console.log('applyAvailabilityPolicy', currentVatID, recent);
    const pos = recent.indexOf(currentVatID);
    // already most recently used
    if (pos + 1 === sizeHint) return;
    if (pos >= 0) recent.splice(pos, 1);
    recent.push(currentVatID);
    // not yet full
    if (recent.length <= sizeHint) return;
    const [lru] = recent.splice(0, 1);
    await evict(lru);
  }

  /** @type {(vatID: string, d: Tagged) => Promise<Tagged> } */
  async function deliverToVat(vatID, delivery) {
    await applyAvailabilityPolicy(vatID);
    return (await provideVatManager(vatID)).deliver(delivery);
  }

  /** @type { (vatID: string) => Promise<void> } */
  async function shutdown(vatID) {
    await evict(vatID);
    idToInitDetail.delete(vatID);
  }

  return harden({
    // TODO: startup() method for start of kernel process
    // see // instantiate all static vats
    // in kernel.js

    initVatManager,
    deliverToVat,

    // mostly for testing?
    activeVatIDs: () => [...idToManager.keys()],

    shutdown, // should this be shutdown for the whole thing?
  });
}

function aStorageAndKeeper() {
  const { storage: hostStorage } = initSwingStore(undefined);
  const { enhancedCrankBuffer, _commitCrank } = wrapStorage(hostStorage);

  const kernelKeeper = makeKernelKeeper(enhancedCrankBuffer);
  kernelKeeper.createStartingKernelState();
  return { storage: enhancedCrankBuffer, kernelKeeper };
}

const json = JSON.stringify;

async function theXSFactory(
  /** @type { ReturnType<typeof makeKernelKeeper> } */ kernelKeeper,
) {
  const load = rel =>
    bundleSource(require.resolve(`../../src//${rel}`), 'getExport');
  const bundles = {
    lockdown: await load('kernel/vatManager/lockdown-subprocess-xsnap.js'),
    supervisor: await load('kernel/vatManager/supervisor-subprocess-xsnap.js'),
  };
  const startXSnap = makeStartXSnap(bundles, { env: process.env });

  /** @type { unknown } */
  const TODO = undefined;
  const xsf = makeXsSubprocessFactory({
    allVatPowers: {
      transformTildot: src => src,
      Remotable,
      getInterfaceOf,
      exitVat: TODO,
      exitVatWithFailure: TODO,
    },
    kernelKeeper,
    startXSnap,
    testLog: _ => {},
    decref: _ => {},
  });

  return xsf;
}

/** @type {(r: string, m: string, ...args: unknown[]) => Tagged} */
const msg = (result, method, ...args) => [
  'message',
  'o+0',
  {
    method,
    args: { body: json(args), slots: [] },
    result,
  },
];
/** @type {(p: string, val: unknown) => Tagged} */
const res = (p, val) => [
  'resolve',
  [[p, false, { body: json(val), slots: [] }]],
];

function mockSyscallHandler() {
  /** @type { Tagged[] } */
  const syscalls = [];

  return {
    /** @type { VatSyscallHandler } */
    handle(syscall) {
      // console.log('syscall', syscall);
      syscalls.push(syscall);
      return ['ok', null];
    },
    get() {
      return [...syscalls];
    },
    reset() {
      syscalls.splice(0, syscalls.length);
    },
  };
}

test('initialize vat; ensure deliveries maintain state', async t => {
  const { storage, kernelKeeper } = aStorageAndKeeper();
  const config = loadBasedir(__dirname);

  const syscalls = mockSyscallHandler();

  // factory for real vatmanagers
  const xsFactory = await theXSFactory(kernelKeeper);

  const targetBundle = await bundleSource(config.vats.target.sourceSpec);

  // Now we have what we need to make a warehouse.
  // and initialize a vat.
  const warehouse = makeVatWarehouse(
    kernelKeeper,
    storage,
    { 'xs-worker': xsFactory },
    () => syscalls.handle,
  );

  warehouse.initVatManager('v1', targetBundle, {
    managerType: 'xs-worker',
    vatParameters: {},
    virtualObjectCacheSize: 1,
    enableSetup: false,
    bundle: undefined,
  });

  // send delivery to vatmanager
  // check impact on mock kernel, or at least; on mock syscall handler

  t.deepEqual(await warehouse.deliverToVat('v1', msg('p-62', 'append', 1)), [
    'ok',
  ]);
  t.deepEqual(syscalls.get(), [
    ['resolve', [['p-62', false, { body: '[1]', slots: [] }]]],
  ]);

  syscalls.reset();

  t.deepEqual(await warehouse.deliverToVat('v1', msg('p-63', 'append', 2)), [
    'ok',
  ]);
  t.deepEqual(syscalls.get(), [res('p-63', [1, 2])]);
});

test('deliver to lots of vats', async t => {
  const vatIDs = ['v1', 'v2', 'v3', 'v4'];

  const { storage, kernelKeeper } = aStorageAndKeeper();
  const config = loadBasedir(__dirname);
  const xsFactory = await theXSFactory(kernelKeeper);
  const targetBundle = await bundleSource(config.vats.target.sourceSpec);
  const syscalls = mockSyscallHandler();

  const warehouse = makeVatWarehouse(
    kernelKeeper,
    storage,
    { 'xs-worker': xsFactory },
    () => syscalls.handle,
    { sizeHint: 3 },
  );

  // initialize a bunch of vats
  vatIDs.forEach(id => {
    warehouse.initVatManager(id, targetBundle, {
      managerType: 'xs-worker',
      vatParameters: {},
      virtualObjectCacheSize: 1,
      enableSetup: false,
      bundle: undefined,
    });
  });

  // Do various deliveries, sometimes to the same vat,
  // sometimes to a different vat.
  const range = n => [...Array(n).keys()];
  const expected = {};
  for await (const iter of range(20)) {
    const id = vatIDs[Math.floor(iter * 17 - iter / 3) % vatIDs.length];
    console.log('delivery', iter, 'to', id);
    t.deepEqual(
      await warehouse.deliverToVat(id, msg(`p-1${iter}`, 'append', iter)),
      ['ok'],
    );

    t.truthy(warehouse.activeVatIDs().length <= 3, 'limit active vats');

    if (!(id in expected)) expected[id] = [];
    expected[id].push(iter);
    console.log('checking syscalls', iter, id, expected[id]);
    t.deepEqual(syscalls.get(), [res(`p-1${iter}`, expected[id])]);
    syscalls.reset();
  }
});
