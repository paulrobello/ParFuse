// eslint-disable-next-line @typescript-eslint/no-var-requires
const Fuse = require('fuse-native');

import { sep as pathSep } from 'path';
import { constants } from 'fs';
import { newFortune } from './fortune';
import {
  addNodeToParent,
  addLink,
  freeFd,
  freePathNode,
  FuseCallback,
  getFdNode,
  getPathFromName,
  getPathNode,
  mkDir,
  mkFd,
  mkFile,
  mkSymLink,
  Node,
  removeNodeFromParent,
  setPathNode,
  truncateFile,
  getFreeInodes,
  getFsStats,
  getFreeBlocks,
  adjustBlocksUsed,
  mkDev,
  ST_NOATIME,
  ST_NODIRATIME,
  fuseNoopCb, mntChroot, unmountChroot
} from './fuseUtils';
import {
  DebugLevel,
  dec2Oct,
  delay,
  getNameFromPath,
  isDirectory,
  isRegularFile,
  openFlagToChars, runCmdAsync
} from './utils';

const debugLevel: DebugLevel = process.env.trace === '1' ? 'trace' : 'none'; // set to trace for logging

/**
 * Used to issue commands to fs via writing commands to /proc/cmd
 * @param path Path to node. Will always start with /proc/
 * @param node the cmd node
 */
const procWritten = async (path: string, node: Node): Promise<void> => {
  const name = getNameFromPath(path);
  if (debugLevel === 'trace') console.log('procWritten(%s, %s)', path, name);
  if (name !== 'cmd') return;
  if (!node.content) return;
  const content = node.content.toString().trim().split(/\r?\n/);
  for (const line of content) {
    if (debugLevel === 'trace') console.log('procWritten line(%s)', line);
    if (line === 'newFortune') {
      await newFortune();
    } else if (line.startsWith('delay')) {
      const duration = line.split(' ');
      if (duration.length !== 2) {
        continue;
      }
      await delay(parseInt(duration[1], 10) || 0);
    }
  }
  unlink(path, fuseNoopCb);
};

const init = function (cb: FuseCallback) {
  if (debugLevel === 'trace') console.log('init()');
  const rootNode = mkDir('', '');
  setPathNode('', rootNode);
  setPathNode(pathSep, rootNode);
  mkDir(pathSep, 'dev');
  mkDir(pathSep + 'pts', 'pts');
  mkDir(pathSep, 'bin');
  mkDir(pathSep, 'lib');
  mkDir(pathSep, 'lib64');
  mkDir(pathSep, 'var');
  mkDir(pathSep + 'log', 'log');
  mkDir(pathSep, 'usr');
  mkDir(pathSep + 'usr', 'bin');
  mkDir(pathSep + 'usr', 'share');
  mkDir(pathSep + 'usr', 'lib');
  mkDir(pathSep, 'etc');
  mkDir(pathSep, 'proc');

  mkDev(pathSep + 'dev', 'null', 259, 8630);
  mkDev(pathSep + 'dev', 'tty', 1280, 8630);
  mkDev(pathSep + 'dev', 'zero', 261, 8630);
  mkDev(pathSep + 'dev', 'random', 264, 8630);

  mkFile(pathSep, 'test', 'Hello World!\n');
  mkSymLink(pathSep, 'testLink', './test');

  // @ts-ignore
  // mntChroot(this.mnt);

  return process.nextTick(cb, 0);
};
const readdir = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('readdir(%s)', path);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (!node.children) {
    return process.nextTick(cb, Fuse.ENOTDIR);
  }
  // console.dir(node.children, { depth: 3 });
  return process.nextTick(
    cb,
    0,
    node.children.map((c) => c.name)
    // node.children.map((c) => c.node?.stat || null)
  );
};
const access = (path: string, mode: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('access(%s, %d(%s))', path, mode, dec2Oct(mode));
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.atime = Date.now();
  return process.nextTick(cb, 0);
};
const getattr = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('getattr(%s)', path);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  return process.nextTick(cb, 0, node.stat);
};
const fgetattr = (fd: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('fgetattr(%d)', fd);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('fgetattr fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }
  return process.nextTick(cb, 0, node.stat);
};
const open = (path: string, flags: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('open(%s, %d[%s])', path, flags, openFlagToChars(flags));
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.atime = Date.now();
  if ((flags & 3) !== constants.O_RDONLY) {
    node.stat.mtime = Date.now();
  }
  const f = mkFd(node);
  if (f < 0) {
    return process.nextTick(cb, Fuse.EMFILE);
  }
  return process.nextTick(cb, 0, f);
};
const opendir = (path: string, flags: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('opendir(%s, %d[%s])', path, flags, openFlagToChars(flags));
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.atime = Date.now();
  if ((flags & 3) !== constants.O_RDONLY) {
    node.stat.mtime = Date.now();
  }
  const f = mkFd(node);
  if (f < 0) {
    return process.nextTick(cb, Fuse.EMFILE);
  }
  return process.nextTick(cb, 0, f);
};

const release = (path: string, fd: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('release(%s, %d)', path, fd);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('release fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }

  freeFd(fd);
  if (path.startsWith(pathSep + 'proc')) {
    procWritten(path, node);
  }
  return process.nextTick(cb, 0);
};

const releasedir = (path: string, fd: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('releasedir(%s, %d)', path, fd);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('releasedir fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }
  freeFd(fd);
  return process.nextTick(cb, 0);
};

const truncate = (path: string, size: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('truncate(%s, %d)', path, size);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  truncateFile(node, size);
  return process.nextTick(cb, 0);
};
const ftruncate = (
  path: string | Buffer,
  fd: number,
  size: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace') console.log('truncate(%s, %d)', path, fd);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('ftruncate fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }
  truncateFile(node, size);
  return process.nextTick(cb, 0);
};
const read = (
  path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('read(%s, %d, %d, %d)', path, fd, len, pos);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('read fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }
  if (!node.content) return process.nextTick(cb, 0);
  const str = node.content.slice(pos, pos + len);
  if (!str) return process.nextTick(cb, 0);
  str.copy(buf);
  return process.nextTick(cb, str.length);
};
const flush = (path: string, fd: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('flush(%s, %d)', path, fd);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('flush fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }

  node.stat.size = node.content?.length || 0;
  node.stat.blocks = Math.ceil(node.stat.size / node.stat.blksize);
  node.stat.atime = Date.now();
  return process.nextTick(cb, 0);
};
const fsync = (
  path: string,
  fd: number,
  datasync: boolean,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('fsync(%s, %d, %s)', path, fd, datasync);
  return flush(path, fd, cb);
};

const fsyncDir = (
  path: string,
  fd: number,
  datasync: boolean,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('fsyncDir(%s, %d, %s)', path, fd, datasync);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('fsyncDir fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }

  return process.nextTick(cb, 0);
};

const listxattr = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('listxattr(%s)', path);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, fuse.ENOENT);
  }
  if (!node.xattr) {
    return process.nextTick(cb, 0, null);
  }
  return process.nextTick(cb, 0, Array.from(node.xattr.keys()));
};

const getxattr = (
  path: string,
  name: string,
  position: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('getxattr(%s, %s, %d)', path, name, position);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, fuse.ENOENT);
  }
  if (!node.xattr) {
    return process.nextTick(cb, 0, null);
  }
  return process.nextTick(cb, 0, node.xattr.get(name) || null);
};

const setxattr = (
  path: string,
  name: string,
  value: Buffer,
  position: number,
  flags: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log(
      'setxattr(%s, %s, %s, %d, %d)',
      path,
      name,
      value,
      position,
      flags
    );
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, fuse.ENOENT);
  }
  // ignore acl related extended attributes
  if (name === 'system.posix_acl_access') {
    return process.nextTick(cb, 0);
  }
  if (!node.xattr) {
    node.xattr = new Map<string, Buffer>();
  }
  node.xattr.set(name, Buffer.from(value.slice(0)));
  node.stat.ctime = Date.now();
  return process.nextTick(cb, 0);
};

const removexattr = (path: string, name: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('removexattr(%s, %s)', path, name);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, fuse.ENOENT);
  }
  if (!node.xattr) {
    return process.nextTick(cb, 0);
  }
  node.xattr.delete(name);
  node.stat.ctime = Date.now();
  return process.nextTick(cb, 0);
};

const create = (path: string, mode: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('create(%s, %d(%s))', path, mode, dec2Oct(mode));
  let node: Node | null = null;
  const p = path.split(pathSep);
  const name = p.pop();
  if (!name) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (name.length > getFsStats().max_name_length) {
    return process.nextTick(cb, Fuse.ENAMETOOLONG);
  }
  if (isRegularFile(mode)) {
    node = mkFile(p.join(pathSep), name, '', mode);
  } else if (isDirectory(mode)) {
    node = mkDir(p.join(pathSep), name, mode);
  }
  if (!node) {
    console.log('create failed. No node');
    return process.nextTick(cb, Fuse.ENOENT);
  }
  const f = mkFd(node);
  if (f < 0) {
    return process.nextTick(cb, Fuse.EMFILE);
  }
  return process.nextTick(cb, 0, f);
};

const mkdir = (path: string, mode: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('mkdir(%s, %d(%s))', path, mode, dec2Oct(mode));
  let node: Node | null = null;
  const p = path.split(pathSep);
  const name = p.pop();
  if (!name) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (name.length > getFsStats().max_name_length) {
    return process.nextTick(cb, Fuse.ENAMETOOLONG);
  }
  node = mkDir(p.join(pathSep), name, mode | constants.S_IFDIR);
  if (!node) {
    console.log('create failed. No node');
    return process.nextTick(cb, Fuse.ENOENT);
  }
  const f = mkFd(node);
  if (f < 0) {
    return process.nextTick(cb, Fuse.EMFILE);
  }
  return process.nextTick(cb, 0, f);
};

export const updateNodeContent = (
  node: Node,
  content: Buffer | string
): number => {
  if (!content) {
    content = Buffer.alloc(0);
  } else if (typeof content === 'string') {
    content = Buffer.from(content);
  }
  node.content = content;
  node.stat.size = node.content.length;
  const blocks_before = node.stat.blocks;
  node.stat.blocks = Math.ceil(node.stat.size / node.stat.blksize);
  if (blocks_before !== node.stat.blocks) {
    if (adjustBlocksUsed(node.stat.blocks - blocks_before) < 1) {
      return Fuse.ENOSPC;
    }
  }
  return 0;
};

const write = (
  path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('write(%s, %d, %d, %d)', path, fd, len, pos);
  const node = getFdNode(fd);
  if (!node) {
    if (debugLevel === 'trace') console.log('write fd not found!');
    return process.nextTick(cb, Fuse.EBADF);
  }

  let content: Buffer;
  if (!node.content) {
    node.content = Buffer.alloc(len + pos);
  }
  if (pos) {
    content = Buffer.concat([
      node.content.slice(0, pos),
      buf.slice(0, len)
      // node.content.slice(pos + len)
    ]);
  } else {
    content = Buffer.from(buf.slice(0, len));
  }
  const ret = updateNodeContent(node, content);

  return process.nextTick(cb, ret < 0 ? ret : len);
};
const unlink = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('unlink(%s)', path);
  if (path === '.' || path === '..') {
    return process.nextTick(cb, Fuse.EINVAL);
  }
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  const parentPath = getPathFromName(path);
  const parentNode = getPathNode(parentPath);
  if (!parentNode) {
    if (debugLevel === 'trace')
      console.log(
        'unlink unable to find parent node (%s, %s)',
        path,
        parentPath
      );
    return process.nextTick(cb, Fuse.ENOENT);
  }
  removeNodeFromParent(parentNode, node, path);
  return process.nextTick(cb, 0);
};
const rmdir = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('rmdir(%s)', path);
  if (path === '.' || path === '..') {
    return process.nextTick(cb, Fuse.EINVAL);
  }
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (node.children && node.children.length > 2) {
    return process.nextTick(cb, Fuse.ENOTEMPTY);
  }
  const parentPath = getPathFromName(path);
  const parentNode = getPathNode(parentPath);
  if (!parentNode) {
    if (debugLevel === 'trace')
      console.log(
        'rmdir unable to find parent node (%s, %s)',
        path,
        parentPath
      );
    return process.nextTick(cb, Fuse.ENOENT);
  }

  removeNodeFromParent(parentNode, node, path);
  freePathNode(path);
  return process.nextTick(cb, 0);
};

const rename = (src: string, dst: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('rename(%s, %s)', src, dst);
  const srcNode = getPathNode(src);
  if (!srcNode) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  const srcParentPath = getPathFromName(src);
  const srcParentNode: Node | null = getPathNode(srcParentPath);
  if (!srcParentNode) {
    if (debugLevel === 'trace')
      console.log(
        'rename parent path node not found (%s, %s)',
        src,
        srcParentPath
      );
    return process.nextTick(cb, Fuse.ENOENT);
  }

  const dstName = getNameFromPath(dst);
  if (dstName.length > getFsStats().max_name_length) {
    return process.nextTick(cb, Fuse.ENAMETOOLONG);
  }
  const dstNode = getPathNode(dst);
  const dstParentPath = getPathFromName(dst);
  const dstParentNode: Node | null = getPathNode(dstParentPath);
  if (!dstParentNode) {
    if (debugLevel === 'trace')
      console.log(
        'rename dst path to node failed to find parent (%s, %s, %s)',
        dst,
        dstParentPath,
        dstName
      );
    return process.nextTick(cb, Fuse.ENOENT);
  }

  if (dstNode && dstParentNode) {
    removeNodeFromParent(dstParentNode, dstNode, dst);
  }
  removeNodeFromParent(srcParentNode, srcNode, src);
  addNodeToParent(dstParentNode, srcNode, dstName, dst);
  return process.nextTick(cb, 0);
};

const readlink = (path: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('readlink(%s)', path);
  const node = getPathNode(path);
  if (!node || !node.content) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  return process.nextTick(cb, 0, node.content.toString());
};

const symlink = (src: string, dst: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('symlink(%s, %s)', src, dst);
  const p = dst.split(pathSep);
  const name = p.pop() || '';
  if (!name) {
    return process.nextTick(cb, Fuse.EINVAL);
  }
  mkSymLink(p.join(pathSep), name, src);
  return process.nextTick(cb, 0);
};

const link = (src: string, dst: string, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('link(%s, %s)', src, dst);
  const srcNode = getPathNode(src);
  if (!srcNode) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (isDirectory(srcNode.stat.mode)) {
    return process.nextTick(cb, Fuse.EINVAL);
  }

  const p = dst.split(pathSep);
  const name = p.pop() || '';
  if (!name) {
    return process.nextTick(cb, Fuse.EINVAL);
  }
  addLink(p.join(pathSep), name, srcNode);
  return process.nextTick(cb, 0);
};

const chown = (path: string, uid: number, gid: number, cb: FuseCallback) => {
  if (debugLevel === 'trace') console.log('chown(%s, %d, %d)', path, uid, gid);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.uid = uid;
  node.stat.gid = gid;
  node.stat.ctime = Date.now();
  return process.nextTick(cb, 0);
};

const chmod = (path: string, mode: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('chmod(%s, %d(%s))', path, mode, dec2Oct(mode));
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.mode = mode;
  node.stat.ctime = Date.now();
  return process.nextTick(cb, 0);
};

const utimens = (
  path: string,
  atime: number,
  mtime: number,
  cb: FuseCallback
) => {
  if (debugLevel === 'trace')
    console.log('utimens(%s, %d, %d)', path, atime, mtime);
  const node = getPathNode(path);
  if (!node) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  node.stat.atime = atime;
  node.stat.mtime = mtime;

  return process.nextTick(cb, 0);
};

const mknod = (path: string, mode: number, rdev: number, cb: FuseCallback) => {
  if (debugLevel === 'trace')
    console.log('mknod(%s, %d(%s), %d)', path, mode, dec2Oct(mode), rdev);
  const p = path.split(pathSep);
  const name = p.pop();
  if (!name) {
    return process.nextTick(cb, Fuse.ENOENT);
  }
  if (name.length > getFsStats().max_name_length) {
    return process.nextTick(cb, Fuse.ENAMETOOLONG);
  }
  mkDev(p.join(pathSep), name, rdev, mode);
  // return process.nextTick(cb, Fuse.ENOENT);
  return process.nextTick(cb, 0);
};

const statfs = (path: string, cb: FuseCallback) => {
  const freeInodes = getFreeInodes();
  const blocksFree = getFreeBlocks();
  const stats = getFsStats();
  const fsStat = {
    fsid: 1000000 /* Filesystem ID. does not appear to be used */,
    frsize:
    stats.block_size /* Fragment size (since Linux 2.6)  should always equal bsize*/,
    bsize: stats.block_size /* Optimal transfer block size */,
    blocks: stats.total_blocks /* Total data blocks in filesystem */,
    bfree: blocksFree /* Free blocks in filesystem */,
    bavail: blocksFree /* Free blocks available to unprivileged user */,
    files: stats.total_inodes /* Total inodes in filesystem */,
    ffree: freeInodes /* Free inodes in filesystem */,
    favail: freeInodes /* Free inodes available to unprivileged user */,
    flag:
      ST_NOATIME |
      ST_NODIRATIME /* Mount flags of filesystem (since Linux 2.6.36) */,
    namemax: stats.max_name_length /* Maximum length of filenames */
  };
  return process.nextTick(cb, 0, fsStat);
};

const ops = {
  init /* Called on filesystem init. */,
  getattr /* Called when a path is being stat'ed */,
  fgetattr /* Same as above but is called when someone stats a file descriptor */,
  access /* Called before the filesystem accessed a file */,
  readdir /* Called when a directory is being listed */,
  readlink /* Called when a symlink is being resolved */,
  symlink /* Called when a new symlink is created */,
  link /* Called when a new link is created */,
  open /* Called when a path is being opened */,
  opendir /* Same as above but for directories */,
  read /* Called when contents of a file is being read */,
  create /* Called when a new file is being opened */,
  truncate /* Called when a path is being truncated to a specific size */,
  ftruncate /* Same as above but on a file descriptor */,
  write /* Called when a file is being written to */,
  flush /* Called when a file descriptor is being flushed */,
  fsync /* Called when a file descriptor is being fsync'ed */,
  fsyncDir /* Same as above but on a directory */,
  release /* Called when a file descriptor is being released */,
  releasedir /* Same as above but for directories */,
  listxattr /* Called when extended attributes of a path are being listed */,
  getxattr /* Called when extended attributes is being read */,
  setxattr /* Called when extended attributes is being set */,
  removexattr /* Called when an extended attribute is being removed */,
  unlink /* Called when a file is being unlinked */,
  mkdir /* Called when a new directory is being created */,
  rmdir /* Called when a directory is being removed */,
  rename /* Called when a file is being renamed */,
  chown /* Called when ownership of a path is being changed */,
  chmod /* Called when the mode of a path is being changed */,
  utimens /* Called when the atime/mtime of a file is being changed */,
  mknod /* Called when the a new device file is being made */,
  statfs /* Called when the filesystem is being stat'ed */,
  mnt: __dirname + '/mnt'
};

Fuse.isConfigured((err: Error, fuseIsConfigured: boolean) => {
  if (debugLevel === 'trace') console.log({fuseIsConfigured});
  if (err) {
    console.error({err});
    return;
  }
  if (!fuseIsConfigured) {
    Fuse.configure((err: Error) => {
      if (err) {
        console.error({err});
      }
    });
  }
});

// console.log('UID=', process.getuid());
const fuse = new Fuse(ops.mnt, ops, {
  debug: false,
  // userId: 0,
  // uid: 0,
  // gid: 0,
  displayFolder: false,
  autoUnmount: true,
  dev: true, // there is a known bug that dev param is ignored when autoUnmount is true
  suid: true, // there is a known bug that suid param is ignored when autoUnmount is true
  force: true,
  kernelCache: false,
  defaultPermissions: true,
  useIno: true,
  fsname: 'ParFS',
  // allowRoot: true // requires privileged user
  allowOther: true // requires privileged user
});
fuse.mount((err?: Error) => {
  if (err) {
    console.log('failed to mount filesystem on ' + fuse.mnt);
    throw err;
  }
  console.log('filesystem mounted on ' + fuse.mnt);
});

// catch SIGINT and attempt to unmount
process.once('SIGINT', async () => {
  // await unmountChroot(fuse.mnt);
  fuse.unmount((err?: Error) => {
    if (err) {
      console.log('filesystem at ' + fuse.mnt + ' not unmounted', err);
    } else {
      console.log('filesystem at ' + fuse.mnt + ' unmounted');
    }
  });
});
