/* avaXS - ava style test runner for XS

Usage:

agoric-sdk/packages/ERTP$ node -r esm ../xsnap/src/avaXS.js test/unitTests/test-*.js
test script: test/unitTests/test-interfaces.js
SES shim...
after ses shim: [ '"hello from XS"', '"ses shim done"' ]
run...
after run: [
'"hello from XS"',
'"ses shim done"',
'"interfaces - abstracted implementation"',
...

*/

/* eslint-disable no-await-in-loop */
import '@agoric/install-ses';
import { xsnap } from './xsnap';

const importMetaUrl = `file://${__filename}`;

/**
 * @param {string[]} argv
 * @param {{
 *   bundleSource: typeof import('@agoric/bundle-source'),
 *   spawn: typeof import('child_process')['spawn'],
 *   osType: typeof import('os')['type'],
 *   readFile: typeof import('fs')['promises']['readFile'],
 * }} io
 */
async function main(argv, { bundleSource, spawn, osType, readFile }) {
  async function testSource(input) {
    const bundle = await bundleSource(input, 'getExport', {
      externals: ['ava'],
    });
    return bundle.source;
  }

  const sesShim = await readFile(
    new URL(`../dist/bootstrap.umd.js`, importMetaUrl).pathname,
  );

  const decoder = new TextDecoder();
  const messages = [];
  async function handleCommand(message) {
    messages.push(decoder.decode(message));
    return new Uint8Array();
  }
  for (const input of argv.slice(2)) {
    console.log('test script:', input);
    const src = await testSource(input);
    messages.splice(0, messages.length);
    const worker = xsnap({
      name: input,
      handleCommand,
      spawn,
      os: osType(),
      debug: true,
    });
    try {
      console.log('SES shim...');
      await worker.evaluate(`
        const { fromString } = ArrayBuffer;
        globalThis.send = item => issueCommand(fromString(JSON.stringify(item)));
        send('hello from XS');
        globalThis.require = function require(specifier) {
          if (specifier !== 'ava') throw Error(specifier);
          return function test(label, t) {
            send(label);
          }
        }
      `);
      await worker.evaluate(sesShim);
      await worker.evaluate(`send('ses shim done')`);
      console.log('after ses shim:', messages);
      console.log('run...');
      await worker.evaluate(
        `try { ${`(${src}\n)()`.trim()} } catch (err) { send(err.message); } finally { send('test script done') }`,
      );
      console.log('after run:', messages);
    } catch (err) {
      console.error(err);
    } finally {
      worker.terminate();
    }
  }
}

/* eslint-disable global-require */
if (require.main === module) {
  main(process.argv, {
    bundleSource: require('@agoric/bundle-source').default,
    spawn: require('child_process').spawn,
    osType: require('os').type,
    readFile: require('fs').promises.readFile,
  }).catch(err => {
    console.error(err);
  });
}
