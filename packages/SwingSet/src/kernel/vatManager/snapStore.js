// @ts-check
import { createHash } from 'crypto';
import { pipeline } from 'stream';
import { createGzip, createGunzip } from 'zlib';
import { assert, details as d } from '@agoric/assert';

const { freeze } = Object;

/**
 * Adapt callback-style API using Promises.
 *
 * Instead of obj.method(...arg, callback),
 * use asPromise(cb => obj.method(...arg, cb)) and get a promise.
 *
 * @param {(cb: (err: E, result: T) => void) => void} calling
 * @returns { Promise<T> }
 * @template T
 * @template E
 */
function asPromise(calling) {
  function executor(
    /** @type {(it: T) => void} */ resolve,
    /** @type {(err: any) => void} */ reject,
  ) {
    const callback = (/** @type { E } */ err, /** @type {T} */ result) => {
      if (err) {
        reject(err);
      }
      resolve(result);
    };

    calling(callback);
  }

  return new Promise(executor);
}

/**
 * @param {string} root
 * @param {{
 *   tmpName: typeof import('tmp').tmpName,
 *   existsSync: typeof import('fs').existsSync
 *   createReadStream: typeof import('fs').createReadStream,
 *   createWriteStream: typeof import('fs').createWriteStream,
 *   resolve: typeof import('path').resolve,
 *   rename: typeof import('fs').promises.rename,
 *   unlink: typeof import('fs').promises.unlink,
 * }} io
 */
export function makeSnapstore(
  root,
  {
    tmpName,
    existsSync,
    createReadStream,
    createWriteStream,
    resolve,
    rename,
    unlink,
  },
) {
  const tmpOpts = { tmpdir: root, template: 'tmp-XXXXXX.xss' };
  /**
   * @param { (name: string) => Promise<T> } thunk
   * @returns { Promise<T> }
   * @template T
   */
  async function withTempName(thunk) {
    const name = await asPromise(cb => tmpName(tmpOpts, cb));
    const result = await thunk(name);
    try {
      await unlink(name);
    } catch (ignore) {
      // ignore
    }
    return result;
  }

  /**
   * @param {string} dest
   * @param { (name: string) => Promise<T> } thunk
   * @returns { Promise<T> }
   * @template T
   */
  async function atomicWrite(dest, thunk) {
    const tmp = await asPromise(cb => tmpName(tmpOpts, cb));
    const result = await thunk(tmp);
    await rename(tmp, resolve(root, dest));
    try {
      await unlink(tmp);
    } catch (ignore) {
      // ignore
    }
    return result;
  }

  /** @type {(input: string, f: NodeJS.ReadWriteStream, output: string) => Promise<void>} */
  async function filter(input, f, output) {
    const source = createReadStream(input);
    const destination = createWriteStream(output);
    await asPromise(cb =>
      pipeline(source, f, destination, err => cb(err, undefined)),
    );
  }

  /** @type {(filename: string) => Promise<string>} */
  function fileHash(filename) {
    return new Promise((done, reject) => {
      const s = (() => {
        try {
          return createReadStream(filename);
        } catch (err) {
          return reject(err);
        }
      })();
      if (!s) return;
      s.on('error', reject);
      const h = createHash('sha256');
      s.pipe(h).end(() => done(h.digest('hex')));
    });
  }

  /**
   * @param {(fn: string) => Promise<void>} saveRaw
   * @returns { Promise<string> } sha256 hash of (uncompressed) snapshot
   */
  async function save(saveRaw) {
    return withTempName(async snapFile => {
      await saveRaw(snapFile);
      const h = await fileHash(snapFile);
      if (existsSync(`${h}.gz`)) return h;
      await atomicWrite(`${h}.gz`, gztmp =>
        filter(snapFile, createGzip(), gztmp),
      );
      return h;
    });
  }

  /**
   * @param {string} hash
   * @param {(fn: string) => Promise<T>} loadRaw
   * @template T
   */
  async function load(hash, loadRaw) {
    return withTempName(async raw => {
      await filter(resolve(root, `${hash}.gz`), createGunzip(), raw);
      const actual = await fileHash(raw);
      assert(actual === hash, d`actual hash ${actual} !== expected ${hash}`);
      // be sure to await loadRaw before exiting withTempName
      const result = await loadRaw(raw);
      return result;
    });
  }

  return freeze({ load, save });
}

export function defaultSnapstorePath({ env = process.env }) {
  // ISSUE: Windows paths?
  const cache = env.XDG_CACHE_HOME || `${env.HOME}/.cache`;
  return `${cache}/agoric-xs-snapshots/`;
}
