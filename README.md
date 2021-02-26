**ParFuse FS** is an example in memory filesystem written in Typescript that attempts to implement all Fuse callbacks 
implemented by the [fuse-friends/fuse-native](https://github.com/fuse-friends/fuse-native) package.

Note for custom INode, Devices file types, or SUID to work you must use 
[my fork of the fuse-native package](https://github.com/paulrobello/fuse-native) and run as a privileged user.

My fork also has support for WinFsp copied from [SandruSebastian/fuse-native](https://github.com/SandruSebastian/fuse-native).

This filesystem implements **very** basic INode and file descriptor tracking.

General utilities are located in _utils.ts_. Fuse or filesystem related items are in fuseUtils.ts. Fortune example items are
located in _fuseUtils.ts_. The main entry point is _index.ts_.

This project attempts to mount the filesystem on _mnt_ in the same folder as the running script. 

ParFuse also has a mechanism to issue commands to the filesystem by writing to _/proc/cmd_.
Contents in /proc/cmd are processed line by line.

Current supported commands are:
- delay timeMs  will delay execution of the next commands for timeMs milliseconds.
- newFortune will create or overwrite the file named fortune in the root of the fs with a random quote obtained from 
  [ruanyf/fortunes](https://raw.githubusercontent.com/ruanyf/fortunes/master/data/fortunes)  

There are some helper functions named _mntChroot_ and _unmountChroot_ that will handle mounting the needed folders from 
the host onto the ParFuse fs to allow you to chroot into the virtual filesystem and run things such as _bash_.
You must be using a privileged user to use these functions.

Most files in this project have a debugLevel const at the top of the file which will when set to 'trace' will enable 
lots of debug output. Trace mode is set by an environment variable named "trace" being set to "1".



Have fun and please give feedback!




