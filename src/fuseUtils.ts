// eslint-disable-next-line @typescript-eslint/no-var-requires
const Fuse = require('fuse-native');

import { constants } from 'fs';
import { sep as pathSep } from 'path';
import { getHeapStatistics } from 'v8';
import {
  DebugLevel,
  dec2Oct,
  ensureNoTrailingSlash,
  ensureStartingSlash,
  ensureTrailingSlash,
  getNameFromPath,
  isDirectory,
  mountFolder,
  umountFolder
} from './utils';

const debugLevel: DebugLevel = process.env.trace === '1' ? 'trace' : 'none'; // set to trace for logging

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FuseCallback = (err: number, ...args: any[]) => void;

export type StatRec = {
  mode: number; // file type and permissions
  uid: number; // user id
  gid: number; // group id
  size: number; // node content size if regular file, 4096 for directories  and symlinks
  dev: number;
  nlink: number; // number of references to the node
  ino: number; // inode number
  rdev: number; // used for device nodes
  blksize: number; // should match fs block_size
  blocks: number; // number blocks content takes, Math.ceil(size/blksize)
  atime: Date | number; // access time
  mtime: Date | number; // modification time
  ctime: Date | number; // change time of meta data
};

export interface childNode {
  name: string; // name of node in directory
  node: Node | null; // referenced node. Will only be null for .. entry in root of fs
}

export interface Node {
  stat: StatRec;
  xattr?: Map<string, Buffer>; // extended attribute storage
  children?: childNode[]; // used by directories to reference child nodes
  content?: Buffer; // used to store file contents or symlink targets
}

export type IFsStats = {
  max_name_length: number;
  block_size: number;
  total_blocks: number;
  blocks_used: number;
  total_inodes: number;
  current_inode: number;
  max_fds: number;
  current_fd: number;
};

let FsStats: IFsStats = {
  max_name_length: 255,
  block_size: 4096,
  total_blocks: Math.ceil(
    (getHeapStatistics().total_available_size / 4096) * 0.75
  ),
  blocks_used: 0,
  total_inodes: 100000,
  current_inode: 0,
  max_fds: 10000, // max open file descriptors
  current_fd: 0
};

/**
 * Allows update of Fstats struct
 * @param fsStats
 */
export const initFsStats = (fsStats: Partial<IFsStats>): IFsStats => {
  FsStats = {...FsStats, ...fsStats};
  return FsStats;
};

/**
 * Get FsStats struct used to track file system inode and block usage and used by statfs
 */
export const getFsStats = (): IFsStats => FsStats;

// full path to node lookup
const path2Node = new Map<string, Node>();
// file descriptor to node lookup
const fd2Node = new Map<number, Node>();
/**
 * Get free inodes in virtual fs
 */
export const getFreeInodes = (): number =>
  FsStats.total_inodes - FsStats.current_inode;
/**
 * Get free blocks in virtual fs
 */
export const getFreeBlocks = (): number =>
  FsStats.total_blocks - FsStats.blocks_used;

/**
 * Adjust free blocks on virtual fs by numBlocks
 * @param numBlocks Number of blocks to add or subtract from total
 */
export const adjustBlocksUsed = (numBlocks: number): number => {
  if (debugLevel === 'trace') console.log('adjustFreeBlocks(%d)', numBlocks);
  FsStats.blocks_used += numBlocks;
  FsStats.blocks_used = Math.max(
    0,
    Math.min(FsStats.blocks_used, FsStats.total_blocks)
  );
  console.log(FsStats);
  return FsStats.total_blocks - FsStats.blocks_used;
};

/**
 * Find and return a free file descriptor for node and assign node to that fd
 * @param node
 * @returns file descriptor or -1 if one was not free
 */
export const mkFd = (node: Node): number => {
  let f;
  let i = FsStats.max_fds; // max attempts to find free file descriptor
  do {
    f = FsStats.current_fd++;
    // wrap the counter if needed
    if (FsStats.current_fd === FsStats.max_fds) {
      FsStats.current_fd = 1;
    }
    i--;
  } while (fd2Node.has(f) && i);
  // if we did not find a free one return -1 as error code
  if (!i) {
    return Fuse.EMFILE;
  }
  // assign the node to the file descriptor
  fd2Node.set(f, node);
  // return the file descriptor
  return f;
};

/**
 * Takes full path and returns the path portion excluding file name
 * @param path
 * @returns path sans file name. If path ends in / then returns entire path
 */
export const getPathFromName = (path: string): string => {
  if (path.endsWith(pathSep)) {
    return path;
  }
  const p = path.split(pathSep);
  p.pop();
  path = p.join(pathSep);
  return ensureStartingSlash(path);
};

/**
 * Remove and unlink node from parent node
 * @param parent Parent node from which to remove node
 * @param node Node to remove
 * @param path Path mapping to remove from path to node lookup
 * @returns true if node was found and unlinked in parent otherwise false
 */
export const removeNodeFromParent = (
  parent: Node,
  node: Node,
  path: string
): boolean => {
  if (debugLevel === 'trace') console.log('removeNodeFromParent(%s)', path);
  freePathNode(path);
  if (!parent.children) {
    return false;
  }
  const name = getNameFromPath(path);
  let i = 0;
  for (const c of parent.children) {
    if (c.name === '.' || c.name === '..') {
      i++;
      continue;
    }
    if (c.name === name) {
      parent.children.splice(i, 1);
      if (isDirectory(node.stat.mode)) {
        parent.stat.nlink--;
        if (parent.stat.nlink < 0) {
          if (debugLevel === 'trace')
            console.error('node nlink less than zero!!!!');
        }
      }
      node.stat.nlink--;
      if (!node.stat.nlink) {
        FsStats.blocks_used -= node.stat.blocks;
      }
      return true;
    }
    i++;
  }
  return false;
};

/**
 * Create a stat record with default values and allow override via rec param
 * @param rec Full or partial StatRec to override defaults
 * @returns complete StatRec with defaults unless overridden by rec
 */
export const mkStatRec = (rec?: Partial<StatRec>): StatRec => {
  // if (FsStats.current_inode === 2) FsStats.current_inode += 100;
  const ret = {
    mode: 0,
    uid: process.getuid ? process.getuid() : 0,
    gid: process.getgid ? process.getgid() : 0,
    size: 0,
    dev: 0,
    nlink: 0,
    ino: FsStats.current_inode++,
    rdev: 0,
    blksize: FsStats.block_size,
    blocks: 0,
    atime: Date.now(),
    mtime: Date.now(),
    ctime: Date.now(),
    ...rec
  };
  if (!ret.blocks) {
    ret.blocks = Math.max(0, Math.ceil((ret?.size || 0) / FsStats.block_size));
  }
  FsStats.blocks_used += ret.blocks;
  return ret;
};

/**
 * Create a folder named name in parentPath
 * @param parentPath Directory to create new directory in
 * @param name Name of new directory
 * @param mode file type and permission to set
 * @returns Directory node
 */
export const mkDir = (
  parentPath: string,
  name: string,
  mode = 0o40755
): Node => {
  parentPath = ensureNoTrailingSlash(parentPath);
  if (debugLevel === 'trace')
    console.log('mkDir(%s, %s, %d(%s))', name, parentPath, mode, dec2Oct(mode));
  const node: Node = {
    stat: mkStatRec({mode, nlink: 1, size: FsStats.block_size})
  };
  node.children = []; // putting this here instead of above keeps typescript happy
  node.children.push({name: '.', node: node});
  node.children.push({name: '..', node: null});
  const parentNode = getPathNode(parentPath);
  if (parentNode)
    addNodeToParent(
      parentNode,
      node,
      name,
      ensureTrailingSlash(parentPath) + name
    );
  return node;
};

/**
 * Add hard link not node named name in parentPath
 * @param parentPath Directory to create hard link in
 * @param name name of hard link
 * @param node Node referenced by hard link
 * @returns Link node
 */
export const addLink = (
  parentPath: string,
  name: string,
  node: Node
): boolean => {
  parentPath = ensureNoTrailingSlash(parentPath);
  if (debugLevel === 'trace') console.log('addLink(%s, %s)', parentPath, name);
  const parentNode = getPathNode(parentPath);
  if (!parentNode) {
    console.error('addLink parent path node not found');
    return false;
  }
  if (!parentNode.children) {
    parentNode.children = [];
  }
  parentNode.children.push({name, node});
  const linkPath = ensureTrailingSlash(parentPath) + name;
  node.stat.nlink++;
  path2Node.set(linkPath, node);
  return true;
};

/**
 * Create file with content named name in parentPath directory
 * @param parentPath Directory to create file in
 * @param name Name of file
 * @param content Content of file
 * @param mode File type and permissions
 * @returns File node
 */
export const mkFile = (
  parentPath: string,
  name: string,
  content: string | Buffer,
  mode = 0o100644
): Node => {
  parentPath = ensureNoTrailingSlash(parentPath);
  if (debugLevel === 'trace')
    console.log(
      'mkFile(%s, %s, %s, %d(%s))',
      name,
      content,
      parentPath,
      mode,
      dec2Oct(mode)
    );
  const node: Node = {
    stat: mkStatRec({
      mode,
      size: content.length
    }),
    content: typeof content === 'string' ? Buffer.from(content) : content
  };
  const parentNode = getPathNode(parentPath);
  if (parentNode) {
    addNodeToParent(
      parentNode,
      node,
      name,
      ensureTrailingSlash(parentPath) + name
    );
  } else {
    if (debugLevel === 'trace') console.warn('mkFile parentNode not found');
  }
  return node;
};

/**
 * Create character special device of type rdev named name in parentPath
 * @param parentPath Directory to create device in
 * @param name Name of device
 * @param rdev Device type
 * @param mode File type and device type
 * @returns Device node
 */
export const mkDev = (
  parentPath: string,
  name: string,
  rdev: number,
  mode = 0o100644
): Node => {
  parentPath = ensureNoTrailingSlash(parentPath);
  if (debugLevel === 'trace')
    console.log(
      'mkDev(%s, %d, %s, %d(%s))',
      name,
      rdev,
      parentPath,
      mode,
      dec2Oct(mode)
    );
  const node: Node = {
    stat: mkStatRec({
      mode,
      rdev
    })
  };
  const parentNode = getPathNode(parentPath);
  if (parentNode) {
    addNodeToParent(
      parentNode,
      node,
      name,
      ensureTrailingSlash(parentPath) + name
    );
  } else {
    if (debugLevel === 'trace') console.warn('mkDev parentNode not found');
  }
  return node;
};

/**
 * Create symlink named name in parentPath to target.
 * Stores symlink target path in content member
 * @param parentPath Directory to create symlink in
 * @param name name of symlink
 * @param target Path to node pointed to by the symlink
 * @returns Symlink node
 */
export const mkSymLink = (
  parentPath: string,
  name: string,
  target: string
): Node => {
  parentPath = ensureNoTrailingSlash(parentPath);
  if (debugLevel === 'trace') console.log('mkSymLink(%s, %s)', name, target);
  const node: Node = {
    stat: mkStatRec({
      mode:
        constants.S_IFLNK |
        constants.S_IRWXU |
        constants.S_IRWXG |
        constants.S_IRWXO,
      size: FsStats.block_size
    }),
    content: Buffer.from(target)
  };
  const parentNode = getPathNode(parentPath);
  if (!parentNode) {
    return node;
  }
  addNodeToParent(
    parentNode,
    node,
    name,
    ensureTrailingSlash(parentPath) + name
  );
  return node;
};

/**
 * Adds node named name to a parentNode directory and add path2Node mapping.
 * @param parentNode Directory node to add node to
 * @param node Node to add to parentNode
 * @param name Name of the node in the parents children list
 * @param path Full path within Fuse FS that will reference the node in this parentNode
 */
export const addNodeToParent = (
  parentNode: Node,
  node: Node,
  name: string,
  path: string
): void => {
  if (debugLevel === 'trace')
    console.log('addNodeToParent(%s, %s)', path, name);
  if (isDirectory(node.stat.mode)) {
    parentNode.stat.nlink++;
    if (!node.children) {
      node.children = [];
    }
    node.children[1].node = parentNode;
  }
  if (!parentNode.children) {
    parentNode.children = [];
  }
  parentNode.children.push({name: name, node});
  node.stat.nlink++;
  path2Node.set(path, node);
};

/**
 * Truncate file node to specified size
 * @param node File node to truncate
 * @param size Size to truncate content to. Usually zero
 */
export const truncateFile = (node: Node, size = 0): void => {
  if (node.content) {
    node.content = node.content.slice(0, size);
  } else {
    node.content = Buffer.alloc(size);
  }
  FsStats.blocks_used -= node.stat.blocks;
  node.stat.size = size;
  node.stat.blocks = Math.ceil(size / FsStats.block_size);
  node.stat.mtime = Date.now();
  FsStats.blocks_used += node.stat.blocks;
};

/**
 * Gets node by is full path within the Fuse FS
 * @param path
 * @returns Node pointed to by path
 */
export const getPathNode = (path: string): Node | null =>
  path2Node.get(path) || null;

/**
 * Sets path reference to node
 * @param path full path within the Fuse FS
 * @param node Node point references
 */
export const setPathNode = (path: string, node: Node): void =>
  path2Node.set(path, node) && undefined;

/**
 * Get list of all paths referencing nodes
 * @returns string[] of paths that reference nodes
 */
export const path2NodeKeys = (): string[] => Array.from(path2Node.keys());

/**
 * Remove path reference to a Node
 * @param path full path within the Fuse FS
 * @returns boolean true if path is found and deleted
 */
export const freePathNode = (path: string): boolean => path2Node.delete(path);

/**
 * Get Node referenced via file descriptor
 * @param fd the file descriptor that references a node
 * @returns Node | null if fd is not found
 */
export const getFdNode = (fd: number): Node | null => fd2Node.get(fd) || null;

/**
 * Remove file descriptor reference to Node
 * @param fd File descriptor
 * @returns boolean true if fd is found and deleted
 */
export const freeFd = (fd: number): boolean => fd2Node.delete(fd);

// folders needed for chroot and bash
export const chRootFolders = [
  '/lib',
  '/lib64',
  '/bin',
  '/usr/share',
  '/usr/bin',
  '/usr/lib',
  '/dev/pts'
];
/**
 * Bind mount all folders from host to corresponding path in fuse root
 * @param root Fuse Fs root folder. Should be absolute.
 * @returns true if all paths are successfully mounted
 */
const mntChroot = async (root: string): Promise<boolean> => {
  let success = true;
  for (const src of chRootFolders) {
    success = success && (await mountFolder(src, root));
  }
  return success;
};
/**
 * Unmount all folders mounted by mntChroot
 * @param root Fuse Fs root folder. Should be absolute.
 * @returns true if all paths are successfully unmounted
 */
const unmountChroot = async (root: string): Promise<boolean> => {
  let success = true;

  for (const src of chRootFolders.reverse()) {
    success =
      success && (await umountFolder(ensureTrailingSlash(root) + 'src'));
  }
  return success;
};

/**
 * No Op function used by functions that want to call functions that are normally called by Fuse
 * @param code Code returned by function < 0 is an error
 * @param args Any params passed back from function
 */
export const fuseNoopCb = (code: number, ...args: any[]): void => undefined;

export const ST_RDONLY = 0x0001; /* mount read-only */
export const ST_NOSUID = 0x0002; /* ignore suid and sgid bits */
export const ST_NODEV = 0x0004; /* disallow access to device special files */
export const ST_NOEXEC = 0x0008; /* disallow program execution */
export const ST_SYNCHRONOUS = 0x0010; /* writes are synced at once */
export const ST_VALID = 0x0020; /* f_flags support is implemented */
export const ST_MANDLOCK = 0x0040; /* allow mandatory locks on an FS */
export const ST_NOATIME = 0x0400; /* do not update access times */
export const ST_NODIRATIME = 0x0800; /* do not update directory access times */
export const ST_RELATIME = 0x1000; /* update atime relative to mtime/ctime */
