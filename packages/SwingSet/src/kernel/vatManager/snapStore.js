// @ts-check
import { assert } from '@agoric/assert';
import { createHash } from 'crypto';
import { pipeline } from 'stream';

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
export function asPromise(calling) {
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
 *
 * @param {*} root
 * @param {{
 *   tmpName: typeof import('tmp').tmpName,
 *   createReadStream: typeof import('fs').createReadStream,
 *   createWriteStream: typeof import('fs').createWriteStream,
 *   resolve: typeof import('path').resolve,
 *   rename: typeof import('fs').promises.rename,
 *   unlink: typeof import('fs').promises.unlink,
 * }} io
 */
export function makeSnapstore(
  root,
  { tmpName, createReadStream, createWriteStream, resolve, rename, unlink },
) {
  /**
   * @param { (name: string) => Promise<T> } thunk
   * @returns { Promise<T> }
   * @template T
   */
  async function withTempName(thunk) {
    const name = await asPromise(cb => tmpName({ tmpdir: root }, cb));
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
    const tmp = await asPromise(cb => tmpName({ tmpdir: root }, cb));
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
  function hash(filename) {
    return new Promise((done, _reject) => {
      const h = createHash('sha256');
      createReadStream(filename)
        .pipe(h)
        .end(_ => done(h.digest('hex')));
    });
  }

  /** @type {(ref: string) => string} */
  const r = ref => resolve(root, ref);
  return freeze({ withTempName, atomicWrite, filter, hash, resolve: r });
}
