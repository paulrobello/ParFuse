import { constants } from 'fs';
import { sep as pathSep } from 'path';
import { ChildProcess, exec } from 'child_process';

export type DebugLevel = 'none' | 'trace';

const debugLevel: DebugLevel = process.env.trace === '1' ? 'trace' : 'none'; // set to trace for logging

/**
 * Helper to test mode field of stat struct against file type mask
 * @param mode to test
 * @param attr mask to use on mode
 * @returns true of (mode & attr) !==0
 */
export const isModeAttr = (mode: number, attr: number): boolean =>
  (mode & attr) !== 0;
/**
 * Test mode member of stat struct to see if it is a regular file
 * @param mode number
 * @returns true if regular file test is true
 */
export const isRegularFile = (mode: number): boolean =>
  isModeAttr(mode, constants.S_IFREG);
/**
 * Test mode member of stat struct to see if it is a directory
 * @param mode number
 * @returns true if directory test is true
 */
export const isDirectory = (mode: number): boolean =>
  isModeAttr(mode, constants.S_IFDIR);

/**
 * Convert number to string of bits.
 * @param dec the number to convert to binary string representation
 * @param bits number of bits to return
 * @returns string of length bits consisting of 1's and 0's
 */
export const dec2bin = (dec: number, bits = 16): string => {
  const r = (dec >>> 0).toString(2).padStart(bits, '0');
  if (r.length > bits) {
    return r.substring(r.length - bits, r.length);
  }
  return r;
};

export const dec2Oct = (dec: number): string => dec.toString(8);

/**
 * Returns last part of full path
 * @param path
 * @returns last part of full path
 */
export const getNameFromPath = (path: string): string =>
  path.split('/').pop() || '/';

/**
 * Pass flags from call to open to get char version
 * @param flags
 * @returns r|w|r+
 */
export const openFlagToChars = (flags: number): string => {
  flags = flags & 3;
  if (flags === 0) return 'r';
  if (flags === 1) return 'w';
  return 'r+';
};

/**
 * Match all occurrences of  // or \\  in strings with dependence on pathSep for OS
 */
const doubleSlashMatcher = new RegExp(
  pathSep.repeat(pathSep === '\\' ? 4 : 2),
  'g'
);

/**
 * Remove double slashes from a path
 * @param path to remove double slashes from
 * @returns path without double slashes
 */
export const removeDoubleSlashes = (path: string): string =>
  path.replace(doubleSlashMatcher, pathSep);

/**
 * Ensure path starts with slash
 * @param path to ensure starts with slash
 * @returns path with starting slash
 */
export const ensureStartingSlash = (path: string): string =>
  path.startsWith(pathSep) ? path : pathSep + path;

/**
 * Ensure path ends with slash
 * @param path to ensure ends with a slash
 * @returns path with trailing slash
 */
export const ensureTrailingSlash = (path: string): string =>
  removeDoubleSlashes(
    ensureStartingSlash(path.endsWith(pathSep) ? path : path + pathSep)
  );

/**
 * Ensure path does not end with slash
 * @param path to ensure does not end with slash
 * @returns path without trailing slash
 */
export const ensureNoTrailingSlash = (path: string): string =>
  removeDoubleSlashes(
    ensureStartingSlash(path.endsWith(pathSep) ? path.slice(0, -1) : path)
  );

/**
 * Returns a Promise that resolves on child exit with code === 0 and rejects on
 * child error or exit code !== 0
 * resolve will always have param value of 0
 * reject will ether have nonzero code value or Error object
 * @param child
 */
export const promiseFromChildProcess = (child: ChildProcess): Promise<number | Error> =>
  new Promise((resolve, reject) => {
    child.addListener('error', reject);
    child.addListener('exit', (code: number, signal: number) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(code);
      }
    });
  });

/**
 * Execute bind mount of src on target with mount options asynchronously
 * @param src Source folder
 * @param target Target folder
 * @param mntOpts options to pass to mount -o defaults to ['ro', 'noatime', 'nodiratime']
 * @returns true on success otherwise false
 */
export const mountFolder = async (
  src: string,
  target: string,
  mntOpts: string[] = ['ro', 'noatime', 'nodiratime']
): Promise<boolean> => {
  target = ensureTrailingSlash(target);
  const cmd = `mount --bind ${
    mntOpts.length ? '-o ' + mntOpts.join(' ') : ''
  }  ${src} ${target}${src}`;
  try {
    const child = exec(cmd);
    const result = await promiseFromChildProcess(child);
    if (debugLevel === 'trace') console.log('mountFolder promise complete: ' + result, cmd);
    return true;
  } catch (err: any) {
    if (debugLevel === 'trace') console.error('mountFolder promise rejected: ' + err, cmd);
    return false;
  }
};

/**
 * Unmount folder from host fs asynchronously
 * @param target folder to unmount
 * @returns true on success otherwise false
 */
export const umountFolder = async (target: string): Promise<boolean> => {
  target = ensureTrailingSlash(target);
  const cmd = `umount ${target}`;
  try {
    const child = exec(cmd);
    const result = await promiseFromChildProcess(child);
    if (debugLevel === 'trace') console.log('umountFolder promise complete: ' + result, cmd);
    return true;
  } catch (err: any) {
    if (debugLevel === 'trace') console.error('umountFolder promise rejected: ' + err, cmd);
    return false;
  }
};

/**
 * Delay for delay milliseconds then resolve
 * @param delay Duration in milliseconds before resolving promise
 * @returns Prom that resolves after specified delay
 */
export const delay = async (delay: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, Math.max(0, delay));
  });
