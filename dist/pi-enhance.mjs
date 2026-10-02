import { createRequire as __piRequire } from "node:module"; const require = __piRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/graceful-fs/polyfills.js"(exports, module) {
    var constants2 = __require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module.exports = patch;
    function patch(fs) {
      if (constants2.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
          function rename2(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename2, fs$rename);
          return rename2;
        })(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      })(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path, mode, callback) {
          fs2.open(
            path,
            constants2.O_WRONLY | constants2.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path, mode) {
          var fd = fs2.openSync(path, constants2.O_WRONLY | constants2.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants2.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path, at, mt, cb) {
            fs2.open(path, constants2.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path, at, mt) {
            var fd = fs2.openSync(path, constants2.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/graceful-fs/legacy-streams.js"(exports, module) {
    var Stream = __require("stream").Stream;
    module.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path, options);
        Stream.call(this);
        var self = this;
        this.path = path;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path, options);
        Stream.call(this);
        this.path = path;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/graceful-fs/clone.js"(exports, module) {
    "use strict";
    module.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/graceful-fs/graceful-fs.js"(exports, module) {
    var fs = __require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = __require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = Symbol.for("graceful-fs.queue");
      previousSymbol = Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs.close);
      fs.closeSync = (function(fs$closeSync) {
        function closeSync2(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync2, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync2;
      })(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          __require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile3;
      function readFile3(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path, options, cb);
        function go$readFile(path2, options2, cb2, startTime) {
          return fs$readFile(path2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile;
      function writeFile(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path, data, options, cb);
        function go$writeFile(path2, data2, options2, cb2, startTime) {
          return fs$writeFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path, data, options, cb);
        function go$appendFile(path2, data2, options2, cb2, startTime) {
          return fs$appendFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, options2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path, options, cb);
        function fs$readdirCallback(path2, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path2, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open2(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open2(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path, options) {
        return new fs2.ReadStream(path, options);
      }
      function createWriteStream(path, options) {
        return new fs2.WriteStream(path, options);
      }
      var fs$open = fs2.open;
      fs2.open = open2;
      function open2(path, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path, flags, mode, cb);
        function go$open(path2, flags2, mode2, cb2, startTime) {
          return fs$open(path2, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts;
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/signal-exit/signals.js"(exports, module) {
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/signal-exit/index.js"(exports, module) {
    var process2 = global.process;
    var processOk = function(process3) {
      return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
    };
    if (!processOk(process2)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process2.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process2.__signal_exit_emitter__) {
        emitter = process2.__signal_exit_emitter__;
      } else {
        emitter = process2.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(global.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        };
        emitter.on(ev, cb);
        return remove;
      };
      unload = function unload2() {
        if (!loaded || !processOk(global.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process2.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process2.emit = originalProcessEmit;
        process2.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      };
      module.exports.unload = unload;
      emit = function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      };
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = function listener() {
          if (!processOk(global.process)) {
            return;
          }
          var listeners = process2.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process2.kill(process2.pid, sig);
          }
        };
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = function load2() {
        if (loaded || !processOk(global.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process2.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process2.emit = processEmit;
        process2.reallyExit = processReallyExit;
      };
      module.exports.load = load;
      originalProcessReallyExit = process2.reallyExit;
      processReallyExit = function processReallyExit2(code) {
        if (!processOk(global.process)) {
          return;
        }
        process2.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        originalProcessReallyExit.call(process2, process2.exitCode);
      };
      originalProcessEmit = process2.emit;
      processEmit = function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(global.process)) {
          if (arg !== void 0) {
            process2.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process2.exitCode, null);
          emit("afterexit", process2.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      };
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
    "use strict";
    var cacheSymbol = Symbol();
    function probe(file, fs, callback) {
      const cachedPrecision = fs[cacheSymbol];
      if (cachedPrecision) {
        return fs.stat(file, (err, stat2) => {
          if (err) {
            return callback(err);
          }
          callback(null, stat2.mtime, cachedPrecision);
        });
      }
      const mtime = new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
      fs.utimes(file, mtime, mtime, (err) => {
        if (err) {
          return callback(err);
        }
        fs.stat(file, (err2, stat2) => {
          if (err2) {
            return callback(err2);
          }
          const precision = stat2.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
          Object.defineProperty(fs, cacheSymbol, { value: precision });
          callback(null, stat2.mtime, precision);
        });
      });
    }
    function getMtime(precision) {
      let now = Date.now();
      if (precision === "s") {
        now = Math.ceil(now / 1e3) * 1e3;
      }
      return new Date(now);
    }
    module.exports.probe = probe;
    module.exports.getMtime = getMtime;
  }
});

// node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var fs = require_graceful_fs();
    var retry = require_retry2();
    var onExit = require_signal_exit();
    var mtimePrecision = require_mtime_precision();
    var locks = {};
    function getLockFile(file, options) {
      return options.lockfilePath || `${file}.lock`;
    }
    function resolveCanonicalPath(file, options, callback) {
      if (!options.realpath) {
        return callback(null, path.resolve(file));
      }
      options.fs.realpath(file, callback);
    }
    function acquireLock(file, options, callback) {
      const lockfilePath = getLockFile(file, options);
      options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
          return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
            if (err2) {
              options.fs.rmdir(lockfilePath, () => {
              });
              return callback(err2);
            }
            callback(null, mtime, mtimePrecision2);
          });
        }
        if (err.code !== "EEXIST") {
          return callback(err);
        }
        if (options.stale <= 0) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        options.fs.stat(lockfilePath, (err2, stat2) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return acquireLock(file, { ...options, stale: 0 }, callback);
            }
            return callback(err2);
          }
          if (!isLockStale(stat2, options)) {
            return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
          }
          removeLock(file, options, (err3) => {
            if (err3) {
              return callback(err3);
            }
            acquireLock(file, { ...options, stale: 0 }, callback);
          });
        });
      });
    }
    function isLockStale(stat2, options) {
      return stat2.mtime.getTime() < Date.now() - options.stale;
    }
    function removeLock(file, options, callback) {
      options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== "ENOENT") {
          return callback(err);
        }
        callback();
      });
    }
    function updateLock(file, options) {
      const lock2 = locks[file];
      if (lock2.updateTimeout) {
        return;
      }
      lock2.updateDelay = lock2.updateDelay || options.update;
      lock2.updateTimeout = setTimeout(() => {
        lock2.updateTimeout = null;
        options.fs.stat(lock2.lockfilePath, (err, stat2) => {
          const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
          if (err) {
            if (err.code === "ENOENT" || isOverThreshold) {
              return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1e3;
            return updateLock(file, options);
          }
          const isMtimeOurs = lock2.mtime.getTime() === stat2.mtime.getTime();
          if (!isMtimeOurs) {
            return setLockAsCompromised(
              file,
              lock2,
              Object.assign(
                new Error("Unable to update lock within the stale threshold"),
                { code: "ECOMPROMISED" }
              )
            );
          }
          const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
          options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
            const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
            if (lock2.released) {
              return;
            }
            if (err2) {
              if (err2.code === "ENOENT" || isOverThreshold2) {
                return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
              }
              lock2.updateDelay = 1e3;
              return updateLock(file, options);
            }
            lock2.mtime = mtime;
            lock2.lastUpdate = Date.now();
            lock2.updateDelay = null;
            updateLock(file, options);
          });
        });
      }, lock2.updateDelay);
      if (lock2.updateTimeout.unref) {
        lock2.updateTimeout.unref();
      }
    }
    function setLockAsCompromised(file, lock2, err) {
      lock2.released = true;
      if (lock2.updateTimeout) {
        clearTimeout(lock2.updateTimeout);
      }
      if (locks[file] === lock2) {
        delete locks[file];
      }
      lock2.options.onCompromised(err);
    }
    function lock(file, options, callback) {
      options = {
        stale: 1e4,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => {
          throw err;
        },
        ...options
      };
      options.retries = options.retries || 0;
      options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
      options.stale = Math.max(options.stale || 0, 2e3);
      options.update = options.update == null ? options.stale / 2 : options.update || 0;
      options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const operation = retry.operation(options.retries);
        operation.attempt(() => {
          acquireLock(file2, options, (err2, mtime, mtimePrecision2) => {
            if (operation.retry(err2)) {
              return;
            }
            if (err2) {
              return callback(operation.mainError());
            }
            const lock2 = locks[file2] = {
              lockfilePath: getLockFile(file2, options),
              mtime,
              mtimePrecision: mtimePrecision2,
              options,
              lastUpdate: Date.now()
            };
            updateLock(file2, options);
            callback(null, (releasedCallback) => {
              if (lock2.released) {
                return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
              }
              unlock(file2, { ...options, realpath: false }, releasedCallback);
            });
          });
        });
      });
    }
    function unlock(file, options, callback) {
      options = {
        fs,
        realpath: true,
        ...options
      };
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const lock2 = locks[file2];
        if (!lock2) {
          return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
        }
        lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
        lock2.released = true;
        delete locks[file2];
        removeLock(file2, options, callback);
      });
    }
    function check(file, options, callback) {
      options = {
        stale: 1e4,
        realpath: true,
        fs,
        ...options
      };
      options.stale = Math.max(options.stale || 0, 2e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        options.fs.stat(getLockFile(file2, options), (err2, stat2) => {
          if (err2) {
            return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
          }
          return callback(null, !isLockStale(stat2, options));
        });
      });
    }
    function getLocks() {
      return locks;
    }
    onExit(() => {
      for (const file in locks) {
        const options = locks[file].options;
        try {
          options.fs.rmdirSync(getLockFile(file, options));
        } catch (e) {
        }
      }
    });
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.check = check;
    module.exports.getLocks = getLocks;
  }
});

// node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
    "use strict";
    var fs = require_graceful_fs();
    function createSyncFs(fs2) {
      const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
      const newFs = { ...fs2 };
      methods.forEach((method) => {
        newFs[method] = (...args) => {
          const callback = args.pop();
          let ret;
          try {
            ret = fs2[`${method}Sync`](...args);
          } catch (err) {
            return callback(err);
          }
          callback(null, ret);
        };
      });
      return newFs;
    }
    function toPromise(method) {
      return (...args) => new Promise((resolve3, reject) => {
        args.push((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve3(result);
          }
        });
        method(...args);
      });
    }
    function toSync(method) {
      return (...args) => {
        let err;
        let result;
        args.push((_err, _result) => {
          err = _err;
          result = _result;
        });
        method(...args);
        if (err) {
          throw err;
        }
        return result;
      };
    }
    function toSyncOptions(options) {
      options = { ...options };
      options.fs = createSyncFs(options.fs || fs);
      if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
        throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
      }
      return options;
    }
    module.exports = {
      toPromise,
      toSync,
      toSyncOptions
    };
  }
});

// node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "node_modules/proper-lockfile/index.js"(exports, module) {
    "use strict";
    var lockfile2 = require_lockfile();
    var { toPromise, toSync, toSyncOptions } = require_adapter();
    async function lock(file, options) {
      const release = await toPromise(lockfile2.lock)(file, options);
      return toPromise(release);
    }
    function lockSync(file, options) {
      const release = toSync(lockfile2.lock)(file, toSyncOptions(options));
      return toSync(release);
    }
    function unlock(file, options) {
      return toPromise(lockfile2.unlock)(file, options);
    }
    function unlockSync(file, options) {
      return toSync(lockfile2.unlock)(file, toSyncOptions(options));
    }
    function check(file, options) {
      return toPromise(lockfile2.check)(file, options);
    }
    function checkSync(file, options) {
      return toSync(lockfile2.check)(file, toSyncOptions(options));
    }
    module.exports = lock;
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.lockSync = lockSync;
    module.exports.unlockSync = unlockSync;
    module.exports.check = check;
    module.exports.checkSync = checkSync;
  }
});

// packages/hosts/pi/src/index.ts
import { existsSync as existsSync5, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname4, join as join8 } from "node:path";
import { fileURLToPath } from "node:url";
import { resizeImage } from "@earendil-works/pi-coding-agent";

// packages/core/src/registry.ts
import { Type } from "typebox";
import { Value } from "typebox/value";

// packages/core/src/module.ts
var MODULE_API_VERSION = 2;

// packages/core/src/auth.ts
var EnhanceError = class extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EnhanceError";
  }
};
var StaticCredentialResolver = class {
  constructor(credentials) {
    this.credentials = credentials;
  }
  async resolve(request) {
    const credential = this.credentials[`${request.provider}/${request.channel}`];
    return credential ? { status: "ready", credential } : {
      status: "missing",
      guidance: `Configure ${request.provider}/${request.channel} credentials in this host.`
    };
  }
};

// packages/core/src/registry.ts
var strings = (values) => Type.Unsafe({ type: "string", enum: [...new Set(values)] });
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var CapabilityRegistry = class {
  entries = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  suspended = /* @__PURE__ */ new Set();
  preferred;
  constructor(preferred = {}) {
    this.preferred = { ...preferred };
  }
  setPreferred(preferred) {
    this.preferred = { ...preferred };
  }
  list() {
    return [...this.entries.values()];
  }
  get(id) {
    return this.entries.get(id);
  }
  load(module, services, binding) {
    const { manifest } = module;
    if (manifest.apiVersion !== MODULE_API_VERSION || module.definition.id !== manifest.capability || manifest.id !== `${manifest.capability}/${manifest.provider}` || !/^[a-z][a-z0-9_]*$/.test(manifest.capability))
      throw new EnhanceError("MODULE_CONTRACT", "Invalid module identity or API version.");
    const id = binding ? `${manifest.id}@${binding.id}` : manifest.id;
    if (this.entries.has(id)) return;
    if (manifest.platforms && !manifest.platforms.includes(process.platform))
      throw new EnhanceError("PLATFORM", `Module requires ${manifest.platforms.join(", ")}.`);
    const instance = module.create(services);
    if (!instance.tool || instance.tool.name !== manifest.capability)
      throw new EnhanceError("MODULE_CONTRACT", "Tool name must match capability.");
    this.entries.set(id, { id, module, instance, binding });
  }
  setBinding(id, binding) {
    const entry = this.entries.get(id);
    if (!entry || entry.binding?.id !== binding.id)
      throw new EnhanceError("MODULE_CONTRACT", "Binding identity cannot change.");
    entry.binding = binding;
  }
  suspend(id) {
    this.suspended.add(id);
  }
  resume(id) {
    this.suspended.delete(id);
  }
  assertIdle(id) {
    if (this.pending.has(id))
      throw new EnhanceError("MODULE_BUSY", "Wait for the active call before unloading.");
  }
  async unload(id) {
    this.assertIdle(id);
    const entry = this.entries.get(id);
    this.suspend(id);
    await entry?.instance.dispose?.();
    this.entries.delete(id);
    this.suspended.delete(id);
  }
  async lifecycle(event, isIdle) {
    const results = await Promise.allSettled(this.list().map((e) => e.instance.lifecycle?.(event, isIdle)));
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        `Lifecycle ${event} failed`
      );
  }
  async dispose() {
    for (const id of this.entries.keys()) this.suspend(id);
    const results = await Promise.allSettled(this.list().map((e) => e.instance.dispose?.()));
    this.entries.clear();
    this.suspended.clear();
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Module cleanup failed"
      );
  }
  tools() {
    const groups = /* @__PURE__ */ new Map();
    for (const entry of this.list())
      if (entry.instance.tool && !this.suspended.has(entry.id)) {
        const cap = entry.module.manifest.capability;
        groups.set(cap, [...groups.get(cap) ?? [], entry]);
      }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(
      ([cap, entries]) => this.merge(
        cap,
        entries.sort(
          (a, b) => a.module.manifest.provider.localeCompare(b.module.manifest.provider) || (a.binding?.id ?? "").localeCompare(b.binding?.id ?? "")
        )
      )
    );
  }
  merge(capability, entries) {
    const implementations = [...new Map(entries.map((e) => [e.module.manifest.provider, e])).values()];
    const providers = implementations.map((e) => e.module.manifest.provider);
    const definition = entries[0].module.definition;
    const first = entries[0].instance.tool;
    const properties = { provider: Type.Optional(strings(providers)) };
    if (entries.some((e) => e.binding))
      properties.service = Type.Optional(
        Type.Unsafe({
          type: "string",
          enum: [...new Set(entries.map((e) => e.binding?.id ?? e.module.manifest.provider))],
          description: "Select an exact service connection: " + entries.map(
            (e) => `${e.binding?.id ?? e.module.manifest.provider} (${e.binding?.label ?? e.module.manifest.provider})`
          ).join(", ")
        })
      );
    const options = {};
    for (const { module, instance } of implementations) {
      const schema = instance.tool.parameters;
      const specific = {};
      const required = schema.required ?? [];
      for (const [key, field] of Object.entries(schema.properties)) {
        const common = definition.commonFields;
        if (common && !common.includes(key))
          specific[key] = required.includes(key) ? field : Type.Optional(field);
        else if (!properties[key]) properties[key] = required.includes(key) ? field : Type.Optional(field);
      }
      if (Object.keys(specific).length)
        options[module.manifest.provider] = Type.Optional(
          Type.Object(specific, { additionalProperties: false })
        );
    }
    Object.assign(
      properties,
      definition.composeParameters?.(implementations.map((e) => e.instance.tool.parameters))
    );
    if (Object.keys(options).length)
      properties.options = Type.Optional(Type.Object(options, { additionalProperties: false }));
    const parameters = Type.Object(properties, { additionalProperties: false });
    return {
      name: capability,
      label: definition.label,
      description: `Providers: ${providers.join(", ")}. Choose provider/service when several connections are available; a saved preference or a sole connection can be used implicitly. Failed calls never fall back.${definition.commonFields ? ` Provider-specific parameters go in options.<provider>.` : ""}
` + implementations.map((e) => `[${e.module.manifest.provider}] ${e.instance.tool.description}`).join("\n"),
      promptSnippet: first.promptSnippet,
      promptGuidelines: [...new Set(entries.flatMap((e) => e.instance.tool.promptGuidelines ?? []))],
      parameters,
      execute: async (callId, raw, signal, onUpdate, context) => {
        signal?.throwIfAborted();
        if (!Value.Check(parameters, raw))
          throw new EnhanceError(
            "INVALID_ARGUMENTS",
            "Arguments do not match the current loaded capability schema."
          );
        const args = raw;
        const candidates = entries.filter(
          (e) => !args.provider || e.module.manifest.provider === args.provider
        );
        const service = args.service ?? this.preferred[capability];
        const matches = service ? candidates.filter((e) => (e.binding?.id ?? e.module.manifest.provider) === service) : candidates;
        const selectable = !args.service && args.provider && !matches.length ? candidates : matches;
        if (selectable.length !== 1)
          throw new EnhanceError(
            "PROVIDER_SELECTION",
            `Choose an exact provider/service for ${capability}; ${selectable.length ? "several connections match" : "selected connection is unavailable"}.`
          );
        const entry = selectable[0];
        const provider = entry.module.manifest.provider;
        const id = entry.id;
        if (this.entries.get(id) !== entry || this.suspended.has(id))
          throw new EnhanceError("STALE_TOOL", "Capability changed; use the refreshed tool schema.");
        const { provider: ignored, service: ignoredService, options: rawOptions, ...common } = args;
        const selectedOptions = object(rawOptions) ? rawOptions : {};
        if (Object.keys(selectedOptions).some((key) => key !== provider))
          throw new EnhanceError("PROVIDER_OPTIONS", "Only options for the selected provider are accepted.");
        const backendOptions = selectedOptions[String(provider)];
        const native = { ...common, ...object(backendOptions) ? backendOptions : {} };
        if (!Value.Check(entry.instance.tool.parameters, native))
          throw new EnhanceError(
            "PROVIDER_ARGUMENTS",
            `Arguments are unsupported by ${provider}; check model and input limits.`
          );
        const activeContext = {
          ...context,
          signal,
          credentials: entry.binding?.credentials ?? context.credentials
        };
        this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
        const normalize = (result) => ({
          ...result,
          details: {
            ...result.details,
            version: 1,
            capability,
            provider,
            ...entry.binding ? { service: entry.binding.id } : {}
          }
        });
        try {
          return normalize(
            await entry.instance.tool.execute(
              callId,
              native,
              signal,
              onUpdate ? (r) => onUpdate(normalize(r)) : void 0,
              activeContext
            )
          );
        } finally {
          const remaining = (this.pending.get(id) ?? 1) - 1;
          if (remaining) this.pending.set(id, remaining);
          else this.pending.delete(id);
        }
      }
    };
  }
};

// packages/core/src/controls.ts
function transformControlledRequest(payload, model, controls, state) {
  if (!model) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let result = payload;
  for (const control of controls) {
    const value = state[control.id] ?? "off";
    if (value !== "off" && control.choices.includes(value) && control.supported(model))
      result = control.transform(result, value, model);
  }
  return result;
}

// packages/integrations/services/src/preferences.ts
import { homedir } from "node:os";
import { join } from "node:path";

// packages/integrations/services/src/json.ts
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    throw new EnhanceError("CONFIG_INVALID", `Cannot read ${path}; original file was not changed.`);
  } finally {
    closeSync(fd);
  }
}
function updateJson(path, fallback, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 384);
  } catch {
    throw new EnhanceError("CONFIG_LOCKED", `Retry after the other writer finishes: ${path}`);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const value = update(readJson(path, fallback));
    const fd = openSync(temp, "wx", 384);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return value;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

// packages/integrations/services/src/preferences.ts
var enhanceHome = () => process.env.AGENT_ENHANCE_HOME ?? join(homedir(), ".agent-enhance");
var emptyPreferences = () => ({ version: 1, preferred: {}, excluded: [] });
var emptyPiPreferences = () => ({
  ...emptyPreferences(),
  requests: {},
  subagents: { enabled: false }
});
var record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function validate(value, pi) {
  if (!record(value) || value.version !== 1 || !record(value.preferred) || Object.values(value.preferred).some((v) => typeof v !== "string" || !v) || !Array.isArray(value.excluded) || value.excluded.some((v) => typeof v !== "string" || !v) || Object.keys(value).some(
    (k) => !["version", "preferred", "excluded", ...pi ? ["requests", "subagents"] : []].includes(k)
  ))
    throw new EnhanceError("CONFIG_INVALID", "Invalid service preferences; original file was not changed.");
  if (pi) {
    const p = value;
    if (!record(p.requests) || Object.values(p.requests).some((v) => typeof v !== "string") || !record(p.subagents) || typeof p.subagents.enabled !== "boolean" || Object.keys(p.subagents).some((k) => !["enabled", "model"].includes(k)) || p.subagents.model !== void 0 && (typeof p.subagents.model !== "string" || !/^[^\s/]+\/\S+$/.test(p.subagents.model)))
      throw new EnhanceError("CONFIG_INVALID", "Invalid Pi preferences; original file was not changed.");
  }
  return value;
}
var PreferenceStore = class {
  constructor(home, host, empty, verifySettings) {
    this.host = host;
    this.empty = empty;
    this.verifySettings = verifySettings;
    this.path = join(home, "preferences", `${host}.json`);
  }
  path;
  load() {
    const value = validate(readJson(this.path, this.empty), this.host === "pi");
    this.verifySettings?.(value);
    return value;
  }
  update(update) {
    return updateJson(this.path, this.empty, (current) => {
      const before = validate(current, this.host === "pi");
      this.verifySettings?.(before);
      const after = validate(update(before), this.host === "pi");
      this.verifySettings?.(after);
      return after;
    });
  }
};

// packages/integrations/services/src/catalog.ts
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";
var CATALOG_VERSION = 2;
var ModuleCatalog = class {
  constructor(catalog, directory) {
    this.catalog = catalog;
    this.directory = directory;
    if (catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.modules))
      throw new Error("Invalid module catalog.");
    const ids = /* @__PURE__ */ new Set();
    for (const entry of catalog.modules) {
      if (entry.apiVersion !== MODULE_API_VERSION || !/^[a-z][a-z0-9_]*\/[a-z][a-z0-9-]*$/.test(entry.id) || entry.id !== `${entry.capability}/${entry.provider}` || entry.file !== `${entry.capability}--${entry.provider}.mjs` || ids.has(entry.id))
        throw new Error("Invalid module catalog entry.");
      ids.add(entry.id);
    }
  }
  find(id) {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new Error(`Unknown capability/provider: ${id}`);
    return entry;
  }
  async load(id) {
    const entry = this.find(id);
    const module = (await import(pathToFileURL(join2(this.directory, entry.file)).href)).default;
    const { file: _file, bytes: _bytes, label: _label, group: _group, ...manifest } = entry;
    if (JSON.stringify(module.manifest) !== JSON.stringify(manifest) || module.definition.id !== entry.capability)
      throw new Error(`Module contract does not match this release: ${id}`);
    return module;
  }
};

// packages/integrations/services/src/contracts.ts
async function discoverServices(sources) {
  const results = await Promise.allSettled(sources.map((source) => source.discover()));
  const connections = /* @__PURE__ */ new Map();
  const errors = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      errors[sources[index].id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return;
    }
    for (const connection2 of result.value) {
      if (connections.has(connection2.id)) throw new Error(`Duplicate service connection: ${connection2.id}`);
      connections.set(connection2.id, connection2);
    }
  });
  return { connections: [...connections.values()], errors };
}

// packages/integrations/services/src/runtime.ts
var ServiceRuntime = class {
  constructor(options) {
    this.options = options;
  }
  snapshot = { connections: [], errors: {} };
  states = [];
  syncing = Promise.resolve();
  stopped = false;
  synchronize(sources, preferences, host, signal) {
    const operation = this.syncing.catch(() => {
    }).then(async () => {
      if (this.stopped) return;
      signal?.throwIfAborted();
      const discovered = await discoverServices(sources);
      signal?.throwIfAborted();
      if (this.stopped) return;
      const failed = new Set(Object.keys(discovered.errors));
      const known = new Set(discovered.connections.map((c) => c.id));
      for (const connection2 of this.snapshot.connections)
        if (failed.has(connection2.source) && !known.has(connection2.id))
          discovered.connections.push(connection2);
      this.snapshot = discovered;
      const wanted = /* @__PURE__ */ new Map();
      const states = [];
      for (const entry of this.options.modules.catalog.modules) {
        const unsupported = entry.platforms && !entry.platforms.includes(host.platform ?? process.platform) ? `Requires ${entry.platforms.join("/")}` : entry.requires?.filter((feature) => !host.features.has(feature)).join(", ");
        if (unsupported) {
          states.push({ module: entry.id, status: "unsupported", reason: unsupported });
          continue;
        }
        const connections = discovered.connections.filter(
          (connection2) => connection2.provider === entry.provider && (entry.auth ? connection2.channel === entry.auth.channel && connection2.kind !== "runtime" && entry.auth.acceptedKinds.includes(connection2.kind) : connection2.kind === "runtime" && connection2.channel === entry.runtime)
        );
        if (!connections.length) {
          states.push({ module: entry.id, status: "missing", reason: "No matching service connection" });
          continue;
        }
        for (const connection2 of connections) {
          const state = { module: entry.id, service: connection2.id, status: "available" };
          if (preferences.excluded.some(
            (key) => [entry.capability, entry.id, `${entry.capability}@${connection2.id}`].includes(key)
          )) {
            state.status = "excluded";
          } else if (entry.modelInputExcludes?.some((input) => host.model?.input?.includes(input))) {
            state.status = "hidden";
            state.reason = "Current model already accepts this input";
          } else wanted.set(`${entry.id}@${connection2.id}`, { entry, connection: connection2 });
          states.push(state);
        }
      }
      const registry = this.options.registry;
      registry.setPreferred(preferences.preferred);
      for (const loaded of registry.list()) {
        if (wanted.has(loaded.id)) {
          registry.resume(loaded.id);
          continue;
        }
        registry.suspend(loaded.id);
        try {
          await registry.unload(loaded.id);
        } catch (error) {
          states.push({
            module: loaded.module.manifest.id,
            service: loaded.binding?.id,
            status: error instanceof EnhanceError && error.code === "MODULE_BUSY" ? "busy" : "error",
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      for (const [id, { entry, connection: connection2 }] of wanted) {
        if (registry.get(id)) {
          registry.setBinding(id, {
            id: connection2.id,
            label: connection2.label,
            credentials: connection2.credentials
          });
          continue;
        }
        try {
          const module = await this.options.modules.load(entry.id);
          signal?.throwIfAborted();
          if (this.stopped) return;
          registry.load(module, this.options.services(entry, connection2), {
            id: connection2.id,
            label: connection2.label,
            credentials: connection2.credentials
          });
        } catch (error) {
          signal?.throwIfAborted();
          const state = states.find((s) => s.module === entry.id && s.service === connection2.id);
          state.status = "error";
          state.reason = error instanceof Error ? error.message : String(error);
        }
      }
      this.states = states;
    });
    this.syncing = operation;
    return operation;
  }
  async dispose() {
    this.stopped = true;
    await this.syncing.catch(() => {
    });
    await this.options.registry.dispose();
  }
  describe() {
    return [
      ...this.snapshot.connections.map((c) => `${c.id} \xB7 ${c.label} \xB7 configured`),
      ...Object.entries(this.snapshot.errors).map(
        ([source, error]) => `${source}: discovery error: ${error}`
      ),
      ...this.states.map(
        (s) => `${s.module}${s.service ? ` @ ${s.service}` : ""}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`
      )
    ].join("\n");
  }
};

// packages/integrations/services/src/sources/files.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { readFile as readFile2 } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";

// packages/integrations/services/src/sources/config-value.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
function interpolateConfigValue(value, env) {
  let missing = false;
  const resolved = value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (match, reference) => {
    if (reference === "$" || reference === "!") return reference;
    const name = reference.startsWith("{") ? reference.slice(1, -1) : reference;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return match;
    const replacement = env[name];
    if (!replacement) {
      missing = true;
      return "";
    }
    return replacement;
  });
  return missing ? void 0 : resolved;
}
function sourceEnvironment(env, extra) {
  return { ...env, ...Object.fromEntries(Object.entries(extra ?? {}).filter(([, value]) => !!value)) };
}
function isConfiguredValue(value, env) {
  return typeof value === "string" && (value.startsWith("!") ? !!value.slice(1).trim() : !!interpolateConfigValue(value, env));
}
async function resolveConfiguredValue(value, env, signal) {
  if (!value.startsWith("!")) return interpolateConfigValue(value, env) ?? "";
  const result = await promisify(exec)(value.slice(1), {
    env,
    signal,
    timeout: 15e3,
    maxBuffer: 1024 * 1024
  });
  return result.stdout.trim();
}

// packages/integrations/services/src/sources/channels.ts
var channels = {
  "openai-codex": { provider: "openai", channel: "codex", kind: "oauth" },
  xai: { provider: "xai", channel: "imagine", kind: "oauth" },
  "opencode-go": {
    provider: "opencode",
    channel: "go",
    kind: "api_key",
    env: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/go/v1/"
  },
  "minimax-cn": {
    provider: "minimax",
    channel: "token-plan",
    kind: "api_key",
    env: "MINIMAX_CN_API_KEY",
    baseUrl: "https://api.minimaxi.com"
  },
  minimax: {
    provider: "minimax",
    channel: "token-plan",
    kind: "api_key",
    env: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io"
  },
  zai: {
    provider: "zai",
    channel: "coding-plan",
    kind: "api_key",
    env: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai"
  },
  "zai-coding-cn": {
    provider: "zai",
    channel: "coding-plan",
    kind: "api_key",
    env: "ZAI_CODING_CN_API_KEY",
    baseUrl: "https://open.bigmodel.cn"
  }
};

// packages/integrations/services/src/sources/codex.ts
import { readFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// packages/integrations/services/src/sources/lock.ts
import { open, rename, rm, stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var STALE_MS = 3e4;
async function withFileLock(path, fn, timeoutMs = 15e3) {
  const lockPath = `${path}.lock`;
  await mkdir(dirname2(path), { recursive: true, mode: 448 });
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const file = await open(lockPath, "wx", 384).catch(
      (error) => error.code === "EEXIST" ? void 0 : error
    );
    if (file instanceof Error) throw file;
    if (file) {
      try {
        await file.writeFile(`${process.pid}
`, "utf8");
      } finally {
        await file.close();
      }
      try {
        return await fn();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
    await new Promise((resolve3) => setTimeout(resolve3, 100));
  }
}
async function writeFileAtomic(path, text) {
  await mkdir(dirname2(path), { recursive: true, mode: 448 });
  const temp = `${path}.${randomUUID2()}.tmp`;
  const file = await open(temp, "wx", 384);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

// packages/integrations/services/src/sources/codex.ts
var CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var CODEX_MARGIN_MS = 12e4;
var codexAuthPath = (env = process.env) => join3(env.CODEX_HOME ?? join3(homedir2(), ".codex"), "auth.json");
function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return void 0;
  }
}
var jwtExpiry = (token) => {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1e3 : void 0;
};
var jwtAccount = (token) => {
  const auth = jwtPayload(token)?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : void 0;
};
var fresh = (expires, margin) => expires === void 0 || expires - margin > Date.now();
function codexConfigured(auth) {
  return !!(auth?.tokens?.refresh_token || auth?.tokens?.access_token && fresh(jwtExpiry(auth.tokens.access_token), CODEX_MARGIN_MS));
}
async function readCodex(path = codexAuthPath()) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw new Error(`${path} is unreadable; run \`codex login\` again.`);
  }
}
async function codexCredential(signal, path = codexAuthPath()) {
  const quick = await readCodex(path);
  const token = quick?.tokens?.access_token;
  if (token && fresh(jwtExpiry(token), CODEX_MARGIN_MS))
    return {
      kind: "oauth",
      secret: token,
      accountId: quick.tokens?.account_id ?? jwtAccount(token),
      expiresAt: jwtExpiry(token)
    };
  if (!quick?.tokens?.refresh_token) return void 0;
  return withFileLock(path, async () => {
    const auth = await readCodex(path);
    const current = auth?.tokens?.access_token;
    if (current && fresh(jwtExpiry(current), CODEX_MARGIN_MS))
      return {
        kind: "oauth",
        secret: current,
        accountId: auth.tokens?.account_id ?? jwtAccount(current),
        expiresAt: jwtExpiry(current)
      };
    const refresh = auth?.tokens?.refresh_token;
    if (!refresh) return void 0;
    const data = await requestRefresh(refresh, signal);
    const accountId = auth.tokens?.account_id ?? jwtAccount(data.access_token);
    await writeFileAtomic(
      path,
      JSON.stringify(
        {
          ...auth,
          tokens: {
            ...auth.tokens,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            ...typeof data.id_token === "string" ? { id_token: data.id_token } : {},
            ...accountId ? { account_id: accountId } : {}
          },
          last_refresh: (/* @__PURE__ */ new Date()).toISOString()
        },
        null,
        2
      )
    );
    return { kind: "oauth", secret: data.access_token, accountId, expiresAt: jwtExpiry(data.access_token) };
  });
}
async function requestRefresh(refresh, signal) {
  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CODEX_CLIENT_ID
    }),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3e4)]) : AbortSignal.timeout(3e4)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string" || typeof data.refresh_token !== "string")
    throw new Error(`Codex token refresh failed (HTTP ${response.status}); run \`codex login\` again.`);
  return data;
}
async function refreshCodex(refresh, signal) {
  const data = await requestRefresh(refresh, signal);
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1e3 : 36e5) - CODEX_MARGIN_MS
  };
}

// packages/integrations/services/src/sources/xai.ts
var CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
var TOKEN_URL = "https://auth.x.ai/oauth2/token";
var REFRESH_SKEW_MS = 5 * 60 * 1e3;
async function postForm(url, fields, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3e4)]) : AbortSignal.timeout(3e4)
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}
var failure = (action, r) => new Error(
  `xAI OAuth ${action} failed (HTTP ${r.status})${typeof r.body.error === "string" ? `: ${r.body.error}` : ""}`
);
function tokens(body, previousRefresh) {
  const access = body.access_token;
  const refresh = body.refresh_token ?? previousRefresh;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh)
    throw new Error("xAI OAuth returned no usable tokens.");
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { kind: "oauth", access, refresh, expires: Date.now() + lifetime * 1e3 - REFRESH_SKEW_MS };
}
async function refreshXai(refresh, signal) {
  const r = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh },
    signal
  );
  if (!r.ok) throw failure("token refresh", r);
  return tokens(r.body, refresh);
}

// packages/integrations/services/src/sources/files.ts
function sourcePaths(options) {
  const env = options.env ?? process.env, root = options.userHome ?? homedir3();
  return [
    join4(env.CODEX_HOME ?? join4(root, ".codex"), "auth.json"),
    join4(env.PI_CODING_AGENT_DIR ?? join4(root, ".pi", "agent"), "auth.json"),
    join4(env.XDG_DATA_HOME ?? join4(root, ".local", "share"), "opencode", "auth.json"),
    join4(options.home, "credentials.json"),
    env.OPENAI_CODEX_COMPUTER_APP ?? "/Applications/ChatGPT.app"
  ];
}
async function readObject(path) {
  try {
    const value = JSON.parse(await readFile2(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(
      `Cannot discover services from ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function resolver(def, resolve3, guidance) {
  return {
    async resolve(request, context) {
      context.signal?.throwIfAborted();
      if (request.provider !== def.provider || request.channel !== def.channel || !request.acceptedKinds.includes(def.kind))
        return {
          status: "unsupported",
          guidance: "Selected service does not support this authentication channel."
        };
      try {
        const credential = await resolve3(context.signal);
        context.signal?.throwIfAborted();
        if (!credential?.secret) return { status: "missing", guidance };
        return { status: "ready", credential };
      } catch (error) {
        context.signal?.throwIfAborted();
        return {
          status: "login_required",
          guidance: `${error instanceof Error ? error.message : String(error)} ${guidance}`
        };
      }
    }
  };
}
function connection(id, source, def, credentials) {
  return {
    id,
    source: source === "Agent Enhance" ? "agent-enhance" : source.toLowerCase(),
    label: `${def.provider} \xB7 ${def.channel} \xB7 ${source}${def.baseUrl ? ` \xB7 ${new URL(def.baseUrl).hostname}` : ""}`,
    ...def,
    credentials
  };
}
var oauthConfigured = (entry) => !!(entry.refresh || entry.access && (entry.expires === void 0 || entry.expires > Date.now()));
async function piCredential(path, provider, def, env, signal) {
  const entry = (await readObject(path))[provider];
  if (!entry) return;
  if (def.kind === "api_key") {
    if (entry.type !== "api_key" || typeof entry.key !== "string") return;
    return {
      kind: "api_key",
      secret: await resolveConfiguredValue(entry.key, sourceEnvironment(env, entry.env), signal),
      baseUrl: def.baseUrl
    };
  }
  if (entry.type !== "oauth") return;
  const current = (value) => ({
    kind: "oauth",
    secret: value.access,
    accountId: value.accountId ?? jwtAccount(value.access),
    expiresAt: value.expires
  });
  if (entry.access && (entry.expires === void 0 || entry.expires > Date.now())) return current(entry);
  if (!entry.refresh) return;
  const release = await import_proper_lockfile.default.lock(path, {
    realpath: false,
    stale: 3e4,
    retries: { retries: 15, factor: 1, minTimeout: 1e3, maxTimeout: 1e3 }
  });
  try {
    signal?.throwIfAborted();
    const file = await readObject(path), latest = file[provider];
    if (!latest || latest.type !== "oauth") return;
    if (latest.access && (latest.expires === void 0 || latest.expires > Date.now()))
      return current(latest);
    const refreshed = provider === "xai" ? await refreshXai(latest.refresh, signal) : await refreshCodex(latest.refresh, signal);
    file[provider] = {
      ...latest,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires
    };
    await writeFileAtomic(path, JSON.stringify(file, null, 2) + "\n");
    return current(file[provider]);
  } finally {
    await release();
  }
}
function fileSources(options) {
  const env = options.env ?? process.env;
  const [codexPath, piPath, opencodePath, ownPath, desktopPath] = sourcePaths(options);
  const sources = [
    {
      id: "codex",
      async discover() {
        const auth = await readCodex(codexPath), tokens2 = auth?.tokens;
        if (!codexConfigured(auth)) return [];
        const def = channels["openai-codex"];
        return [
          connection(
            "codex:openai-codex",
            "Codex",
            def,
            resolver(
              def,
              (signal) => codexCredential(signal, codexPath),
              "Run codex login, then refresh services."
            )
          )
        ];
      }
    },
    {
      id: "opencode",
      async discover() {
        const content = () => env.OPENCODE_AUTH_CONTENT ? Promise.resolve(JSON.parse(env.OPENCODE_AUTH_CONTENT)) : readObject(opencodePath);
        const file = await content(), def = channels["opencode-go"];
        const entry = file["opencode-go"];
        if (entry?.type !== "api" || !entry.key) return [];
        return [
          connection(
            "opencode:opencode-go",
            "OpenCode",
            def,
            resolver(
              def,
              async () => {
                const latest = (await content())["opencode-go"];
                return latest?.type === "api" ? { kind: "api_key", secret: latest.key, baseUrl: def.baseUrl } : void 0;
              },
              "Configure the OpenCode Go connection in OpenCode."
            )
          )
        ];
      }
    },
    {
      id: "agent-enhance",
      async discover() {
        const file = await readObject(ownPath);
        if (!Object.keys(file).length) return [];
        if (file.version !== 1 || !file.credentials || typeof file.credentials !== "object")
          throw new Error(`Invalid credential source: ${ownPath}`);
        const result = [];
        for (const [channel, entry] of Object.entries(file.credentials)) {
          const def = Object.values(channels).find(
            (c) => `${c.provider}/${c.channel}` === channel && c.kind === entry.kind
          );
          if (!def || (entry.kind === "oauth" ? !oauthConfigured(entry) : !isConfiguredValue(entry.key, sourceEnvironment(env, entry.env))))
            continue;
          const selected = { ...def, baseUrl: entry.baseUrl ?? def.baseUrl };
          result.push(
            connection(
              `agent-enhance:${channel}`,
              "Agent Enhance",
              selected,
              resolver(
                def,
                async (signal) => {
                  const latest = (await readObject(ownPath)).credentials?.[channel];
                  if (!latest || latest.kind !== def.kind) return;
                  if (latest.kind === "api_key")
                    return {
                      kind: "api_key",
                      secret: await resolveConfiguredValue(
                        latest.key,
                        sourceEnvironment(env, latest.env),
                        signal
                      ),
                      baseUrl: latest.baseUrl ?? def.baseUrl
                    };
                  if (latest.expires === void 0 || latest.expires > Date.now())
                    return { kind: "oauth", secret: latest.access, expiresAt: latest.expires };
                  if (def.provider !== "xai")
                    throw new Error(`No OAuth refresh implementation for ${channel}`);
                  return withFileLock(ownPath, async () => {
                    const file2 = await readObject(ownPath), now = file2.credentials?.[channel];
                    if (!now || now.kind !== "oauth") return;
                    if (now.expires <= Date.now()) {
                      file2.credentials[channel] = { ...now, ...await refreshXai(now.refresh, signal) };
                      await writeFileAtomic(ownPath, JSON.stringify(file2, null, 2) + "\n");
                    }
                    const token = file2.credentials[channel];
                    return { kind: "oauth", secret: token.access, expiresAt: token.expires };
                  });
                },
                `Authenticate ${def.provider} in its original account source.`
              )
            )
          );
        }
        return result;
      }
    },
    {
      id: "desktop",
      async discover() {
        return (options.platform ?? process.platform) === "darwin" && existsSync2(desktopPath) ? [
          {
            id: "local:chatgpt-desktop",
            source: "desktop",
            label: "ChatGPT desktop runtime",
            provider: "openai",
            channel: "chatgpt-desktop",
            kind: "runtime",
            credentials: new StaticCredentialResolver({})
          }
        ] : [];
      }
    }
  ];
  if (!options.nativePi)
    sources.push(
      {
        id: "pi",
        async discover() {
          const file = await readObject(piPath), result = [];
          for (const [provider, def] of Object.entries(channels)) {
            const entry = file[provider];
            if (!entry || (def.kind === "oauth" ? entry.type !== "oauth" || !oauthConfigured(entry) : entry.type !== "api_key" || !isConfiguredValue(entry.key, sourceEnvironment(env, entry.env))))
              continue;
            result.push(
              connection(
                `pi:${provider}`,
                "Pi",
                def,
                resolver(
                  def,
                  (signal) => piCredential(piPath, provider, def, env, signal),
                  `Authenticate ${provider} using Pi /login.`
                )
              )
            );
          }
          return result;
        }
      },
      {
        id: "environment",
        async discover() {
          return Object.values(channels).filter((def) => def.env && env[def.env]).map(
            (def) => connection(
              `env:${def.env}`,
              "Environment",
              def,
              resolver(
                def,
                async () => ({ kind: "api_key", secret: env[def.env] ?? "", baseUrl: def.baseUrl }),
                `Set ${def.env}.`
              )
            )
          );
        }
      }
    );
  return sources;
}

// packages/integrations/services/src/watch.ts
import { existsSync as existsSync3, watch } from "node:fs";
import { dirname as dirname3, join as join5, resolve } from "node:path";
function watchServiceSources(paths, changed) {
  let watchers = [], timer, closed = false;
  const targets = [...new Set(paths.map((path) => resolve(path)))];
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!closed) {
        start();
        changed();
      }
    }, 150);
    timer.unref();
  };
  const start = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    const directories = /* @__PURE__ */ new Set();
    for (const target of targets) {
      let directory = dirname3(target);
      while (!existsSync3(directory) && dirname3(directory) !== directory) directory = dirname3(directory);
      directories.add(directory);
    }
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, file) => {
          if (file) {
            const touched = join5(directory, String(file));
            if (!targets.some((target) => target === touched || target.startsWith(`${touched}/`))) return;
          }
          schedule();
        });
        watcher.on("error", schedule);
        watchers.push(watcher);
      } catch {
      }
    }
  };
  start();
  return () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

// packages/hosts/pi/src/auth.ts
import { readFileSync as readFileSync2, existsSync as existsSync4 } from "node:fs";
import { join as join6 } from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";

// node_modules/strip-json-comments/index.js
var singleComment = Symbol("singleComment");
var multiComment = Symbol("multiComment");
var stripWithoutWhitespace = () => "";
var stripWithWhitespace = (string, start, end) => string.slice(start, end).replace(/[^ \t\r\n]/g, " ");
var isEscaped = (jsonString, quotePosition) => {
  let index = quotePosition - 1;
  let backslashCount = 0;
  while (jsonString[index] === "\\") {
    index -= 1;
    backslashCount += 1;
  }
  return Boolean(backslashCount % 2);
};
function stripJsonComments(jsonString, { whitespace = true, trailingCommas = false } = {}) {
  if (typeof jsonString !== "string") {
    throw new TypeError(`Expected argument \`jsonString\` to be a \`string\`, got \`${typeof jsonString}\``);
  }
  const strip = whitespace ? stripWithWhitespace : stripWithoutWhitespace;
  let isInsideString = false;
  let isInsideComment = false;
  let offset = 0;
  let buffer = "";
  let result = "";
  let commaIndex = -1;
  for (let index = 0; index < jsonString.length; index++) {
    const currentCharacter = jsonString[index];
    const nextCharacter = jsonString[index + 1];
    if (!isInsideComment && currentCharacter === '"') {
      const escaped = isEscaped(jsonString, index);
      if (!escaped) {
        isInsideString = !isInsideString;
      }
    }
    if (isInsideString) {
      continue;
    }
    if (!isInsideComment && currentCharacter + nextCharacter === "//") {
      buffer += jsonString.slice(offset, index);
      offset = index;
      isInsideComment = singleComment;
      index++;
    } else if (isInsideComment === singleComment && currentCharacter + nextCharacter === "\r\n") {
      index++;
      isInsideComment = false;
      buffer += strip(jsonString, offset, index);
      offset = index;
      continue;
    } else if (isInsideComment === singleComment && currentCharacter === "\n") {
      isInsideComment = false;
      buffer += strip(jsonString, offset, index);
      offset = index;
    } else if (!isInsideComment && currentCharacter + nextCharacter === "/*") {
      buffer += jsonString.slice(offset, index);
      offset = index;
      isInsideComment = multiComment;
      index++;
      continue;
    } else if (isInsideComment === multiComment && currentCharacter + nextCharacter === "*/") {
      index++;
      isInsideComment = false;
      buffer += strip(jsonString, offset, index + 1);
      offset = index + 1;
      continue;
    } else if (trailingCommas && !isInsideComment) {
      if (commaIndex !== -1) {
        if (currentCharacter === "}" || currentCharacter === "]") {
          buffer += jsonString.slice(offset, index);
          result += strip(buffer, 0, 1) + buffer.slice(1);
          buffer = "";
          offset = index;
          commaIndex = -1;
        } else if (currentCharacter !== " " && currentCharacter !== "	" && currentCharacter !== "\r" && currentCharacter !== "\n") {
          buffer += jsonString.slice(offset, index);
          offset = index;
          commaIndex = -1;
        }
      } else if (currentCharacter === ",") {
        result += buffer + jsonString.slice(offset, index);
        buffer = "";
        offset = index;
        commaIndex = index;
      }
    }
  }
  const remaining = isInsideComment === singleComment ? strip(jsonString, offset) : jsonString.slice(offset);
  return result + buffer + remaining;
}

// packages/hosts/pi/src/auth.ts
var PiCredentialResolver = class {
  constructor(registry, providerId, reloadModels) {
    this.registry = registry;
    this.providerId = providerId;
    this.reloadModels = reloadModels;
  }
  async resolve(request, context) {
    context.signal?.throwIfAborted();
    const provider = this.providerId;
    const channel = channels[provider];
    if (!channel || channel.provider !== request.provider || channel.channel !== request.channel)
      return {
        status: "unsupported",
        guidance: `Pi authentication does not support ${request.provider}/${request.channel}.`
      };
    const guidance = `Authenticate using Pi /login and select ${provider}.`;
    try {
      const signal = AbortSignal.any([
        ...context.signal ? [context.signal] : [],
        AbortSignal.timeout(15e3)
      ]);
      if (this.reloadModels) await this.reloadModels(signal);
      signal.throwIfAborted();
      const resolved = await new Promise(
        (resolve3, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          this.registry.getProviderAuth(provider).then(resolve3, reject).finally(() => signal.removeEventListener("abort", abort));
        }
      );
      context.signal?.throwIfAborted();
      const auth = resolved?.auth;
      const headers = new Headers();
      for (const [key, value] of Object.entries(auth?.headers ?? {}))
        if (typeof value === "string") headers.set(key, value);
      const secret = auth?.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!secret) return { status: "missing", guidance };
      const kind = channel.kind;
      if (kind === "oauth" && secret.split(".").length !== 3)
        return {
          status: "login_required",
          guidance: `${guidance} This capability requires subscription OAuth, not a platform API key.`
        };
      if (!request.acceptedKinds.includes(kind))
        return {
          status: "unsupported",
          guidance: "This channel does not accept the credential type resolved by Pi."
        };
      return {
        status: "ready",
        credential: {
          kind,
          secret,
          accountId: headers.get("chatgpt-account-id") ?? void 0,
          baseUrl: auth?.baseUrl ?? channel.baseUrl
        }
      };
    } catch {
      context.signal?.throwIfAborted();
      return { status: "login_required", guidance };
    }
  }
};
function piServiceSource(ctx, options = {}) {
  return {
    id: "pi",
    async discover() {
      const env = options.env ?? process.env;
      const path = join6(getAgentDir(), "models.json");
      const models = options.modelConfig ?? (existsSync4(path) ? JSON.parse(stripJsonComments(readFileSync2(path, "utf8").replace(/^\uFEFF/, ""))).providers ?? {} : {});
      const readStored = options.storedCredential ?? ((id) => readStoredCredential(id));
      return Object.entries(channels).flatMap(([providerId, channel]) => {
        const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
        const stored = readStored(providerId);
        const extension = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        const runtime = status.configured && (status.source === "runtime" || channel.kind === "api_key" && (status.source === "fallback" || isConfiguredValue(extension?.apiKey, env)));
        const configured = runtime || stored?.type === channel.kind && (channel.kind === "oauth" ? !!(stored.refresh || stored.access && (stored.expires === void 0 || stored.expires > Date.now())) : isConfiguredValue(stored.key, sourceEnvironment(env, stored.env))) || channel.kind === "api_key" && !!(channel.env && env[channel.env] || isConfiguredValue(models[providerId]?.apiKey, sourceEnvironment(env, models[providerId]?.env)));
        if (!configured) return [];
        return [
          {
            id: `pi:${providerId}`,
            source: "pi",
            provider: channel.provider,
            channel: channel.channel,
            kind: channel.kind,
            label: `${providerId} \xB7 Pi`,
            credentials: new PiCredentialResolver(
              ctx.modelRegistry,
              providerId,
              models[providerId]?.apiKey ? async (signal) => {
                await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [providerId], signal });
              } : void 0
            )
          }
        ];
      });
    }
  };
}
var piSourcePaths = () => [join6(getAgentDir(), "auth.json"), join6(getAgentDir(), "models.json")];

// packages/hosts/pi/src/history.ts
var object2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function piHistory(entries) {
  const messages = [];
  for (const entry of entries)
    if (object2(entry)) {
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction" && Array.isArray(entry.retainedTail))
        messages.push(...entry.retainedTail);
    }
  return messages.flatMap((message) => {
    if (!object2(message) || message.role !== "user" && message.role !== "assistant") return [];
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(object2).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
    return text ? [{ role: message.role, content: text }] : [];
  });
}

// packages/hosts/pi/src/footer.ts
import { isAbsolute, relative, resolve as resolve2, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
var sanitize = (text) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
var formatTokens = (count) => {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
};
var formatCwd = (cwd, home) => {
  if (!home) return cwd;
  const relativePath = relative(resolve2(home), resolve2(cwd));
  const inside = relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  if (!inside) return cwd;
  return relativePath === "" ? "~" : `~${sep}${relativePath}`;
};
function installEnhanceFooter(ctx, statusKey, getLabels) {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {
      },
      render(width) {
        let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;
        const labels = getLabels().filter((label) => label.value.length > 0);
        const labelsPlain = labels.map((label) => `${label.id}:${label.value}`).join(" ");
        const minGap = 2;
        const pwdWidth = visibleWidth(pwd);
        let labelsText;
        if (labelsPlain && pwdWidth + minGap + visibleWidth(labelsPlain) <= width) {
          labelsText = labelsPlain;
        } else if (labelsPlain) {
          const available = width - pwdWidth - minGap;
          if (available >= 8) labelsText = truncateToWidth(labelsPlain, available, "\u2026");
        }
        let firstLine = theme.fg("dim", truncateToWidth(pwd, width, theme.fg("dim", "...")));
        if (labelsText) {
          const styled = labels.map((label) => theme.fg(label.active ? "accent" : "dim", `${label.id}:${label.value}`)).join(" ");
          if (labelsText === labelsPlain) {
            const padding = " ".repeat(width - pwdWidth - visibleWidth(labelsPlain));
            firstLine = theme.fg("dim", pwd) + padding + styled;
          } else {
            firstLine = theme.fg("dim", pwd) + " ".repeat(minGap) + theme.fg("dim", labelsText);
          }
        }
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        let latestCacheHitRate;
        const add = (usage2) => {
          input += usage2.input;
          output += usage2.output;
          cacheRead += usage2.cacheRead;
          cacheWrite += usage2.cacheWrite;
          cost += usage2.cost?.total ?? 0;
        };
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "usage" && entry.usage) add(entry.usage);
          else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
            add(entry.message.usage);
            const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
            latestCacheHitRate = promptTokens > 0 ? entry.message.usage.cacheRead / promptTokens * 100 : void 0;
          } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage)
            add(entry.message.usage);
          else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
            add(entry.usage);
        }
        const statsParts = [];
        if (input) statsParts.push(`\u2191${formatTokens(input)}`);
        if (output) statsParts.push(`\u2193${formatTokens(output)}`);
        if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
        if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== void 0)
          statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
        const usingSubscription = ctx.model?.provider === "kimi-coding";
        if (cost || usingSubscription)
          statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = contextUsage?.percent ?? 0;
        const contextDisplay = contextUsage?.percent == null ? `?/${formatTokens(contextWindow)}` : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
        statsParts.push(
          percent > 90 ? theme.fg("error", contextDisplay) : percent > 70 ? theme.fg("warning", contextDisplay) : contextDisplay
        );
        if (process.env.PI_EXPERIMENTAL === "1")
          statsParts.push(`${theme.fg("dim", "\u2022")} ${theme.fg("warning", "xp")}`);
        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }
        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel || "off";
          rightSide = thinkingLevel === "off" ? `${modelName} \u2022 thinking off` : `${modelName} \u2022 ${thinkingLevel}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
        }
        const rightWidth = visibleWidth(rightSide);
        const lines = [];
        if (statsLeftWidth + 2 + rightWidth <= width) {
          const padding = " ".repeat(width - statsLeftWidth - rightWidth);
          lines.push(theme.fg("dim", statsLeft + padding + rightSide));
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          if (availableForRight > 0) {
            const truncated = truncateToWidth(rightSide, availableForRight, "");
            lines.push(
              theme.fg(
                "dim",
                statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) + truncated
              )
            );
          } else lines.push(theme.fg("dim", statsLeft));
        }
        const otherStatuses = [...footerData.getExtensionStatuses()].filter(([key]) => key !== statusKey).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitize(text));
        if (otherStatuses.length)
          lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
        return [firstLine, ...lines];
      }
    };
  });
}

// packages/integrations/services/src/management.ts
var serviceUsage = "services | status | refresh | prefer <capability> <service|auto> | exclude|include <capability> [service]";
function manageServicePreferences(args, store, runtime) {
  const [action, capability, service, ...rest] = args;
  if (action === "services")
    return runtime.snapshot.connections.map((c) => `${c.id} \xB7 ${c.label}`).join("\n") || "No service connections discovered. Sign in using the original provider application or configure an API key in the host/environment.";
  if (action === "status") {
    const p = store.load();
    return `${runtime.describe() || "No services discovered."}
Preferred: ${JSON.stringify(p.preferred)}
Excluded: ${JSON.stringify(p.excluded)}`;
  }
  if (!["prefer", "exclude", "include"].includes(action ?? "")) return;
  if (!capability || rest.length || !runtime.options.modules.catalog.modules.some((e) => e.capability === capability))
    throw new Error(serviceUsage);
  if (service && !(action === "prefer" && service === "auto") && !runtime.snapshot.connections.some(
    (c) => c.id === service && runtime.options.modules.catalog.modules.some(
      (e) => e.capability === capability && e.provider === c.provider && (e.auth?.channel ?? e.runtime) === c.channel
    )
  ))
    throw new Error(`Service ${service} does not provide ${capability}.`);
  if (action === "prefer") {
    if (!service) throw new Error(serviceUsage);
    store.update((p) => {
      const preferred = { ...p.preferred };
      if (service === "auto") delete preferred[capability];
      else preferred[capability] = service;
      return { ...p, preferred };
    });
    return `Preferred ${capability}: ${service}.`;
  }
  const key = service ? `${capability}@${service}` : capability;
  store.update((p) => ({
    ...p,
    excluded: action === "exclude" ? [.../* @__PURE__ */ new Set([...p.excluded, key])] : p.excluded.filter((k) => k !== key)
  }));
  return `${action === "exclude" ? "Excluded" : "Included"} ${key}.`;
}

// packages/transports/openai/src/model-support.ts
var SUPPORT = Object.freeze({
  "gpt-6-astra": { verbosity: true, originalImages: true, priority: true },
  "gpt-6-sol": { verbosity: true, originalImages: true, priority: true },
  "gpt-6-luna": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-sol": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-terra": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-luna": { verbosity: true, originalImages: true, priority: true },
  "gpt-daybreak-blue-latest": { verbosity: true, originalImages: true, priority: false },
  "gpt-daybreak-red-latest": { verbosity: true, originalImages: true, priority: false },
  "gpt-5.5": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.4": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.4-mini": { verbosity: true, originalImages: true, priority: false },
  "gpt-5.2": { verbosity: true, originalImages: false, priority: false },
  "codex-auto-review": { verbosity: true, originalImages: true, priority: true }
});
function supportsModelOption(modelId, option) {
  return Object.hasOwn(SUPPORT, modelId) && SUPPORT[modelId][option];
}

// packages/hosts/pi/src/requests/context.ts
function supportsRequestOption(model, option) {
  return model.provider === "openai" && model.channel === "codex" && model.api === "codex-responses" && supportsModelOption(model.id, option);
}
function matchesRequest(payload, model) {
  return Array.isArray(payload.input) && payload.model === model.id;
}

// packages/hosts/pi/src/requests/fast.ts
function fastCreditMultiplier(modelId) {
  if (modelId === "gpt-5.4") return 2;
  if ([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ].includes(modelId))
    return 2.5;
  return void 0;
}
var fastControl = {
  id: "fast",
  choices: ["off", "on"],
  description: "Priority tier: higher ChatGPT credit consumption",
  enabledNotice: "Fast requests service_tier=priority. ChatGPT credits: GPT-5.4 costs 2x; GPT-5.5/5.6/GPT-6 Astra/Sol/Luna cost 2.5x Standard where available. API token pricing is separate. Actual account billing/availability is backend-controlled.",
  formatValue(value, model) {
    const multiplier = fastCreditMultiplier(model.id);
    return value === "on" && multiplier ? `on(${multiplier}x)` : value;
  },
  supported: (model) => supportsRequestOption(model, "priority"),
  transform: (payload, value, model) => matchesRequest(payload, model) && value === "on" && payload.service_tier !== "priority" ? { ...payload, service_tier: "priority" } : payload
};

// packages/transports/openai/src/http.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/hosts/pi/src/requests/verbosity.ts
var verbosityControl = {
  id: "verbosity",
  choices: ["off", "low", "medium", "high"],
  description: "Answer detail; off preserves the host's setting",
  supported: (model) => supportsRequestOption(model, "verbosity"),
  transform(payload, value, model) {
    if (!matchesRequest(payload, model)) return payload;
    if (value === "off" || !["low", "medium", "high"].includes(value)) return payload;
    if (payload.text !== void 0 && !isRecord(payload.text)) return payload;
    const text = isRecord(payload.text) ? payload.text : {};
    if (text.verbosity === value) return payload;
    return { ...payload, text: { ...text, verbosity: value } };
  }
};

// packages/hosts/pi/src/requests/image-detail.ts
function originalBlocks(value) {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const blocks = value.map((block) => {
    if (!isRecord(block) || block.type !== "input_image" || block.detail === "original") return block;
    changed = true;
    return { ...block, detail: "original" };
  });
  return changed ? blocks : value;
}
var imageDetailControl = {
  id: "image_detail",
  choices: ["off", "original"],
  description: "Request original image detail",
  enabledNotice: "Only changes input_image.detail. It does not disable host image resizing or recover original pixels from previews; read the saved original when needed.",
  supported: (model) => model.input?.includes("image") === true && supportsRequestOption(model, "originalImages"),
  transform(payload, value, model) {
    if (!matchesRequest(payload, model)) return payload;
    if (value !== "original" || !Array.isArray(payload.input)) return payload;
    let changed = false;
    const input = payload.input.map((item) => {
      if (!isRecord(item)) return item;
      const key = item.type === "function_call_output" ? "output" : item.type === "message" || item.role === "user" ? "content" : void 0;
      if (!key) return item;
      const blocks = originalBlocks(item[key]);
      if (blocks === item[key]) return item;
      changed = true;
      return { ...item, [key]: blocks };
    });
    return changed ? { ...payload, input } : payload;
  }
};

// packages/hosts/pi/src/requests/index.ts
var requestControls = [fastControl, verbosityControl, imageDetailControl];
function verifyRequestPreferences(preferences) {
  for (const [id, value] of Object.entries(preferences.requests)) {
    const control = requestControls.find((c) => c.id === id);
    if (!control || !control.choices.includes(value))
      throw new EnhanceError(
        "CONFIG_INVALID",
        `Invalid request setting ${id}: choose ${control?.choices.join(" / ") ?? "a supported request control"}.`
      );
  }
}

// packages/hosts/pi/src/management.ts
var usage = `/pi-enhance ${serviceUsage}; fast on|off; verbosity off|low|medium|high; image_detail off|original; subagents enable|disable|status|model [provider/id|inherit]|cancel <batch-id>; computer status|reset|ask|auto|revoke`;
function registerManagement(pi, options) {
  const { store, subagents, report } = options;
  const subagentsPanel = async (ctx) => {
    const saved = options.preferences().subagents.model;
    const choice = await ctx.ui.select(
      `\u5B50\u4EE3\u7406 / Subagents \xB7 ${subagents.isEnabled() ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528"}
\u9ED8\u8BA4\u6A21\u578B\uFF1A${saved ?? "\u7EE7\u627F\u5F53\u524D Pi \u6A21\u578B"}`,
      ["\u9009\u62E9\u9ED8\u8BA4\u6A21\u578B", subagents.isEnabled() ? "\u7981\u7528" : "\u542F\u7528", "\u72B6\u6001"]
    );
    if (choice === "\u9009\u62E9\u9ED8\u8BA4\u6A21\u578B") await run("subagents model", ctx);
    else if (choice === "\u542F\u7528") await run("subagents enable", ctx);
    else if (choice === "\u7981\u7528") await run("subagents disable", ctx);
    else if (choice === "\u72B6\u6001") await run("subagents status", ctx);
  };
  const capabilityPanel = async (ctx) => {
    const runtime = options.runtime();
    const capabilities = [
      ...new Map(runtime.options.modules.catalog.modules.map((e) => [e.capability, e])).values()
    ];
    const labels = capabilities.map(
      (e) => `${e.label} / ${e.capability} \xB7 ${runtime.states.filter((s) => s.module.startsWith(`${e.capability}/`) && s.status === "available").length} \u4E2A\u53EF\u7528\u8FDE\u63A5`
    );
    const choice = await ctx.ui.select("\u80FD\u529B / Capabilities", labels);
    const entry = capabilities[labels.indexOf(choice ?? "")];
    if (!entry) return;
    const excluded = options.preferences().excluded.includes(entry.capability);
    const action = await ctx.ui.select(
      `${entry.label} \xB7 \u504F\u597D\u8FDE\u63A5\uFF1A${options.preferences().preferred[entry.capability] ?? "\u81EA\u52A8\u9009\u62E9"}`,
      ["\u9009\u62E9\u504F\u597D\u8FDE\u63A5", "\u4F7F\u7528\u81EA\u52A8\u9009\u62E9", excluded ? "\u6062\u590D\u81EA\u52A8\u63D0\u4F9B" : "\u6392\u9664\u80FD\u529B", "\u72B6\u6001"]
    );
    if (action === "\u4F7F\u7528\u81EA\u52A8\u9009\u62E9") await run(`prefer ${entry.capability} auto`, ctx);
    else if (action === "\u6392\u9664\u80FD\u529B" || action === "\u6062\u590D\u81EA\u52A8\u63D0\u4F9B")
      await run(`${excluded ? "include" : "exclude"} ${entry.capability}`, ctx);
    else if (action === "\u72B6\u6001")
      report(
        ctx,
        runtime.states.filter((s) => s.module.startsWith(`${entry.capability}/`)).map((s) => `${s.module} @ ${s.service ?? "\u2014"}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`).join("\n")
      );
    else if (action === "\u9009\u62E9\u504F\u597D\u8FDE\u63A5") {
      const ids = new Set(
        runtime.states.filter((s) => s.module.startsWith(`${entry.capability}/`) && s.service).map((s) => s.service)
      );
      const connections = runtime.snapshot.connections.filter((c) => ids.has(c.id));
      const labels2 = connections.map((c) => `${c.id} \xB7 ${c.label}`);
      const selected = await ctx.ui.select("\u9009\u62E9\u670D\u52A1\u8FDE\u63A5", labels2);
      const connection2 = connections[labels2.indexOf(selected ?? "")];
      if (connection2) await run(`prefer ${entry.capability} ${connection2.id}`, ctx);
    }
  };
  const panel = async (ctx) => {
    const choice = await ctx.ui.select("Pi Enhance \xB7 \u670D\u52A1\u4E0E\u504F\u597D", [
      "\u670D\u52A1\u5546 / Services",
      "\u80FD\u529B / Capabilities",
      "\u8BF7\u6C42\u589E\u5F3A / Requests",
      "\u5B50\u4EE3\u7406 / Subagents",
      "\u72B6\u6001 / Status",
      "\u5237\u65B0 / Refresh",
      "\u684C\u9762\u7BA1\u7406 / Computer"
    ]);
    if (choice === "\u670D\u52A1\u5546 / Services") await run("services", ctx);
    else if (choice === "\u80FD\u529B / Capabilities") await capabilityPanel(ctx);
    else if (choice === "\u5B50\u4EE3\u7406 / Subagents") await subagentsPanel(ctx);
    else if (choice === "\u72B6\u6001 / Status") await run("status", ctx);
    else if (choice === "\u5237\u65B0 / Refresh") await run("refresh", ctx);
    else if (choice === "\u684C\u9762\u7BA1\u7406 / Computer") {
      const action = await ctx.ui.select("\u684C\u9762\u7BA1\u7406", ["status", "reset", "ask", "auto", "revoke"]);
      if (action) await run(`computer ${action}`, ctx);
    } else if (choice === "\u8BF7\u6C42\u589E\u5F3A / Requests") {
      const selected = await ctx.ui.select(
        "\u8BF7\u6C42\u589E\u5F3A",
        requestControls.map((c) => `${c.id}: ${options.preferences().requests[c.id] ?? "off"}`)
      );
      const control = requestControls.find((c) => selected?.startsWith(`${c.id}:`));
      if (control) await run(control.id, ctx);
    }
  };
  const run = async (text, ctx) => {
    options.signal().throwIfAborted();
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode === "tui") await panel(ctx);
      else report(ctx, usage);
      return;
    }
    const [action, value, extra] = words;
    if (action === "subagents") {
      if (value === "status" && words.length === 2) {
        report(ctx, subagents.status(ctx));
        return;
      }
      if (value === "model" && words.length <= 3) {
        const models = subagents.availableModels(ctx);
        let selected = extra;
        if (!selected) {
          if (ctx.mode !== "tui")
            throw new Error("Use /pi-enhance subagents model <provider/id>|inherit outside TUI.");
          const inherit = "inherit current Pi model";
          const labels = models.map(
            (m) => `${m.provider}/${m.id} \xB7 ${m.name} \xB7 ${m.input.join("/")} \xB7 ${m.reasoning ? "thinking" : "no thinking"}`
          );
          const choice = await ctx.ui.select(
            `Subagent default model: ${options.preferences().subagents.model ?? inherit}`,
            [inherit, ...labels]
          );
          if (!choice) return;
          if (choice === inherit) selected = "inherit";
          else {
            const model = models[labels.indexOf(choice)];
            if (!model) throw new Error("Invalid model selection.");
            selected = `${model.provider}/${model.id}`;
          }
        }
        if (selected !== "inherit" && !models.some((m) => `${m.provider}/${m.id}` === selected))
          throw new Error(`Model ${selected} is not enabled and available in this Pi session.`);
        store.update((p) => ({
          ...p,
          subagents: { enabled: p.subagents.enabled, ...selected === "inherit" ? {} : { model: selected } }
        }));
        await options.synchronize(ctx);
        report(
          ctx,
          `Saved subagent default model: ${selected === "inherit" ? "inherit current Pi model" : selected}. No model calls.`
        );
        return;
      }
      if ((value === "enable" || value === "disable") && words.length === 2) {
        store.update((p) => ({ ...p, subagents: { ...p.subagents, enabled: value === "enable" } }));
        await options.synchronize(ctx);
        report(ctx, `Subagents ${value === "enable" ? "enabled" : "disabled"}.`);
        return;
      }
      if (value === "cancel" && extra && words.length === 3) {
        report(
          ctx,
          subagents.cancel(extra) ? `Cancelling subagent batch ${extra}.` : `No active subagent batch ${extra}.`
        );
        return;
      }
      throw new Error(usage);
    }
    const control = requestControls.find((c) => c.id === action);
    if (control) {
      if (words.length > 2) throw new Error(usage);
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui")
          throw new Error(`Use /pi-enhance ${action} <${control.choices.join("|")}> outside TUI.`);
        selected = await ctx.ui.select(
          `${control.id}: ${options.preferences().requests[control.id] ?? "off"}`,
          [...control.choices]
        );
        if (!selected) return;
      }
      if (!control.choices.includes(selected)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      store.update((p) => {
        const requests = { ...p.requests };
        if (selected === "off") delete requests[control.id];
        else requests[control.id] = selected;
        return { ...p, requests };
      });
      await options.synchronize(ctx);
      report(
        ctx,
        `Saved ${control.id}: ${selected}. ${selected === "off" ? "No request override." : control.enabledNotice ?? "Only applied to supported API/models."}`
      );
      return;
    }
    if (action === "computer" && words.length === 2) {
      const instance = options.runtime().options.registry.list().find((e) => e.instance.manage)?.instance;
      if (!instance) throw new Error("No ChatGPT desktop runtime was discovered.");
      report(ctx, await instance.manage(value));
      return;
    }
    if (action === "refresh" && words.length === 1) {
      await options.synchronize(ctx);
      report(ctx, options.runtime().describe() || "No services discovered.");
      return;
    }
    const result = manageServicePreferences(words, store, options.runtime());
    if (result === void 0) throw new Error(usage);
    if (!["status", "services"].includes(action)) await options.synchronize(ctx);
    report(
      ctx,
      action === "status" ? `${result}
Requests: ${JSON.stringify(options.preferences().requests)}
${subagents.status(ctx)}` : result
    );
  };
  let busy = false;
  pi.registerCommand("pi-enhance", {
    description: "Discover services and manage capability preferences",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "services",
        "refresh",
        "subagents enable",
        "subagents disable",
        "subagents status",
        "subagents model",
        "subagents model inherit",
        ...requestControls.flatMap((c) => [c.id, ...c.choices.map((v) => `${c.id} ${v}`)]),
        ...new Set(
          options.runtime().options.modules.catalog.modules.flatMap((e) => [
            `prefer ${e.capability} auto`,
            `exclude ${e.capability}`,
            `include ${e.capability}`
          ])
        ),
        ...options.runtime().states.flatMap((s) => s.service ? [`prefer ${s.module.split("/")[0]} ${s.service}`] : [])
      ];
      return candidates.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(text, ctx) {
      if (busy) {
        report(ctx, "Another preference operation is running.", true);
        return;
      }
      busy = true;
      try {
        await ctx.waitForIdle();
        await options.synchronize(ctx);
        await run(text, ctx);
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), true);
      } finally {
        busy = false;
      }
    }
  });
}

// packages/hosts/pi/src/subagents/index.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { Type as Type2 } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";

// packages/hosts/pi/src/subagents/runner.ts
import { join as join7 } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir as getAgentDir2,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
async function runSubagent(task, index, model, thinkingLevel, registry, parentRegistry, signal, onProgress) {
  const cwd = task.cwd ?? process.cwd();
  const agentDir = getAgentDir2();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join7(agentDir, "auth.json"),
    modelsPath: join7(agentDir, "models.json"),
    allowModelNetwork: false
  });
  for (const providerId of parentRegistry.getRegisteredProviderIds()) {
    const native = parentRegistry.getRegisteredNativeProvider(providerId);
    const config = parentRegistry.getRegisteredProviderConfig(providerId);
    if (native) modelRuntime.registerNativeProvider(native);
    else if (config) modelRuntime.registerProvider(providerId, config);
  }
  const requestedModel = modelRuntime.getModel(model.provider, model.id);
  if (!requestedModel)
    throw new Error(`Model ${model.provider}/${model.id} cannot be reconstructed in an isolated Pi session.`);
  const enhanced = new Map(registry.tools().map((tool2) => [tool2.name, tool2]));
  const customTools = (task.tools ?? []).filter((name) => enhanced.has(name)).map((name) => {
    const tool2 = enhanced.get(name);
    return {
      ...tool2,
      execute: (id, args, toolSignal, update, ctx) => {
        const context = {
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          host: "pi",
          credentials: new StaticCredentialResolver({}),
          signal: toolSignal,
          model: ctx.model ? {
            id: ctx.model.id,
            provider: ctx.model.provider === "openai-codex" ? "openai" : ctx.model.provider,
            channel: ctx.model.provider === "openai-codex" ? "codex" : void 0,
            api: ctx.model.api === "openai-codex-responses" ? "codex-responses" : ctx.model.api,
            input: ctx.model.input
          } : void 0,
          history: piHistory(ctx.sessionManager.buildContextEntries())
        };
        return tool2.execute(id, args, toolSignal, update, context);
      }
    };
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: requestedModel,
    thinkingLevel,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: task.tools ?? [],
    customTools,
    excludeTools: ["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"]
  });
  let turns = 0;
  let limit;
  const usage2 = { input: 0, output: 0, cost: 0 };
  let phase = "starting";
  let tool;
  const recent = [];
  const report = () => onProgress?.({ phase, tool, turns, usage: { ...usage2 }, recent: recent.map((entry) => ({ ...entry })) });
  const updateRecent = (source, text, name, append = false) => {
    if (!text) return;
    const previous = recent.at(-1);
    if (append && previous?.source === source && previous.tool === name)
      previous.text = (previous.text + text).slice(-500);
    else {
      recent.push({ source, tool: name, text: text.slice(-500) });
      if (recent.length > 3) recent.shift();
    }
    report();
  };
  const toolText = (result) => {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
      return "";
    return result.content.filter(
      (item) => item?.type === "text" && typeof item.text === "string"
    ).map((item) => item.text.slice(-500)).join("\n").slice(-500);
  };
  let timer;
  const abort = (reason) => {
    if (limit) return;
    limit = reason;
    void session.abort();
  };
  const onAbort = () => abort("cancelled");
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      if (task.max_turns && turns >= task.max_turns) abort("max_turns");
      else {
        phase = "thinking";
        tool = void 0;
        report();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      updateRecent("assistant", event.assistantMessageEvent.delta, void 0, true);
    if (event.type === "tool_execution_start") {
      phase = "tool";
      tool = event.toolName;
      report();
    }
    if (event.type === "tool_execution_update")
      updateRecent("tool", toolText(event.partialResult), event.toolName);
    if (event.type === "tool_execution_end") {
      updateRecent("tool", toolText(event.result), event.toolName);
      phase = "thinking";
      tool = void 0;
      report();
    }
    if (event.type === "turn_end") {
      turns++;
      report();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      usage2.input += event.message.usage?.input ?? 0;
      usage2.output += event.message.usage?.output ?? 0;
      usage2.cost += event.message.usage?.cost?.total ?? 0;
      report();
    }
  });
  try {
    report();
    await session.bindExtensions({ mode: "print" });
    const actual = new Set(session.getActiveToolNames());
    for (const name of task.tools ?? [])
      if (!actual.has(name)) throw new Error(`Tool ${name} is unavailable in the child Pi session.`);
    if (signal.aborted) abort("cancelled");
    else signal.addEventListener("abort", onAbort, { once: true });
    if (task.timeout_seconds) timer = setTimeout(() => abort("timeout"), task.timeout_seconds * 1e3);
    if (!limit) await session.prompt(task.context, { expandPromptTemplates: false });
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    const text = session.getLastAssistantText() || last?.errorMessage || "(no output)";
    return {
      index,
      model: `${model.provider}/${model.id}`,
      status: limit ?? (last?.stopReason === "error" || last?.stopReason === "aborted" ? "failed" : "completed"),
      text,
      turns,
      usage: usage2
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}

// packages/hosts/pi/src/subagents/index.ts
var TaskSchema = Type2.Object(
  {
    context: Type2.String({
      minLength: 1,
      maxLength: 1e5,
      description: "Complete task and context for this independent Pi agent. The parent transcript is not copied."
    }),
    tools: Type2.Optional(
      Type2.Array(Type2.String(), {
        maxItems: 32,
        description: "Exact Pi tool names. Omit or use [] for no tools. Only currently active parent tools may be requested."
      })
    ),
    model: Type2.Optional(
      Type2.String({
        description: "Exact provider/model-id from view_subagent_models. Overrides the saved subagent default; otherwise inherits the current Pi model."
      })
    ),
    thinking_level: Type2.Optional(
      Type2.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => Type2.Literal(x))
      )
    ),
    cwd: Type2.Optional(
      Type2.String({
        description: "Child working directory; defaults to the parent cwd. Not a filesystem sandbox."
      })
    ),
    timeout_seconds: Type2.Optional(
      Type2.Integer({
        minimum: 1,
        maximum: 2147483,
        description: "Optional wall-clock limit. Omitted means no agent-enhance time limit."
      })
    ),
    max_turns: Type2.Optional(
      Type2.Integer({
        minimum: 1,
        maximum: 1e6,
        description: "Optional Pi agent-turn limit. Omitted means no agent-enhance turn limit."
      })
    )
  },
  { additionalProperties: false }
);
var CallSchema = Type2.Object(
  { tasks: Type2.Array(TaskSchema, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false }
);
var ModelsSchema = Type2.Object(
  {
    query: Type2.Optional(Type2.String({ description: "Filter by provider, ID or name" })),
    input: Type2.Optional(Type2.Union([Type2.Literal("text"), Type2.Literal("image")])),
    reasoning: Type2.Optional(Type2.Boolean()),
    offset: Type2.Optional(Type2.Integer({ minimum: 0 }))
  },
  { additionalProperties: false }
);
var ViewSchema = Type2.Object(
  {
    batchId: Type2.Optional(Type2.String({ description: "Batch ID returned by call_subagents" })),
    id: Type2.Optional(Type2.String({ description: "Task ID returned by call_subagents or view_subagents" }))
  },
  { additionalProperties: false }
);
var CancelSchema = Type2.Object(
  { batchId: Type2.String({ minLength: 1, description: "Batch ID to cancel" }) },
  { additionalProperties: false }
);
var HOST_TOOLS = /* @__PURE__ */ new Set(["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"]);
var EFFECTFUL = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "bash",
  "powershell",
  "gen_image",
  "gen_video",
  "gen_voice",
  "use_computer"
]);
var BUILTIN = /* @__PURE__ */ new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
var LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function thinkingLevels(model) {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== void 0);
  });
}
var PAGE_SIZE = 30;
var MAX_RUNNING = 4;
var MAX_QUEUED = 32;
var OUTPUT_CHARS = 12e3;
var PREVIEW_CHARS = 400;
var HISTORY_LIMIT = 24;
var Subagents = class {
  constructor(pi, registry, runner = runSubagent) {
    this.pi = pi;
    this.registry = registry;
    this.runner = runner;
    pi.registerMessageRenderer("pi-enhance:subagents", (message, { expanded, outputPad }, theme) => {
      const details = message.details;
      const results = details?.results ?? [];
      const good = results.filter((r) => r.status === "completed").length;
      const lines = [
        theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", `  ${details?.batchId ?? "batch"}`)
      ];
      lines.push(
        theme.fg(
          results.length && good === results.length ? "success" : "warning",
          results.length ? `${good}/${results.length} completed` : "Batch error"
        ) + theme.fg(
          "muted",
          ` \xB7 ${results.length ? "final results" : "details"}${details?.elapsedMs !== void 0 ? ` \xB7 ${(details.elapsedMs / 1e3).toFixed(1)}s` : ""}`
        )
      );
      for (const result of results) {
        const color = result.status === "completed" ? "success" : "warning";
        lines.push(
          theme.fg(
            color,
            `${result.status === "completed" ? "\u2713" : "!"} Task ${result.index + 1} \xB7 ${result.status}`
          ) + theme.fg("muted", ` \xB7 ${result.model} \xB7 ${result.turns} turns`)
        );
        if (expanded) {
          lines.push(
            theme.fg(
              "muted",
              `  id ${details?.taskIds?.[result.index] ?? "\u2014"} \xB7 ${details?.taskElapsedMs?.[result.index] === void 0 ? "\u2014" : `${(details.taskElapsedMs[result.index] / 1e3).toFixed(1)}s`} \xB7 ${result.usage.input} in / ${result.usage.output} out \xB7 $${result.usage.cost.toFixed(4)}`
            )
          );
          lines.push(result.text.slice(0, OUTPUT_CHARS));
        } else lines.push(theme.fg("dim", result.text.replace(/\s+/g, " ").slice(0, 160)));
      }
      if (!results.length)
        lines.push(
          typeof message.content === "string" ? message.content.slice(0, expanded ? 2500 : 300) : "(no results)"
        );
      const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    });
  }
  batches = /* @__PURE__ */ new Map();
  history = /* @__PURE__ */ new Map();
  renderWatchers = /* @__PURE__ */ new Map();
  pendingRenders = /* @__PURE__ */ new Map();
  renderTimer;
  activeRunners = 0;
  waiters = [];
  owner;
  enabled = false;
  defaultModel;
  closed = false;
  setEnabled(enabled) {
    if (this.enabled && !enabled) this.cancelAll();
    this.enabled = enabled;
  }
  isEnabled() {
    return this.enabled;
  }
  setDefaultModel(model) {
    this.defaultModel = model;
  }
  getDefaultModel() {
    return this.defaultModel;
  }
  startSession(sessionId) {
    if (this.owner && this.owner !== sessionId) this.cancelAll();
    this.owner = sessionId;
    this.closed = false;
  }
  cancelAll() {
    for (const batch of this.batches.values()) batch.controller.abort();
    this.batches.clear();
    this.history.clear();
    this.renderWatchers.clear();
    for (const timer of this.pendingRenders.values()) clearTimeout(timer);
    this.pendingRenders.clear();
    this.stopRenderTimer();
  }
  shutdown() {
    this.closed = true;
    this.cancelAll();
    this.owner = void 0;
  }
  cancel(id) {
    const batch = this.batches.get(id);
    if (!batch) return false;
    batch.controller.abort();
    for (const state of batch.states) {
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      } else if (state.status === "running") state.status = "cancelling";
    }
    this.notifyRender(batch.id);
    return true;
  }
  stopRenderTimer() {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = void 0;
  }
  notifyRender(id) {
    const pending = this.pendingRenders.get(id);
    if (pending) clearTimeout(pending);
    this.pendingRenders.delete(id);
    for (const invalidate of this.renderWatchers.get(id) ?? []) invalidate();
  }
  scheduleRender(id) {
    if (!this.renderWatchers.has(id) || this.pendingRenders.has(id)) return;
    const timer = setTimeout(() => this.notifyRender(id), 200);
    timer.unref();
    this.pendingRenders.set(id, timer);
  }
  watchRender(id, invalidate) {
    let watchers = this.renderWatchers.get(id);
    if (!watchers) {
      watchers = /* @__PURE__ */ new Set();
      this.renderWatchers.set(id, watchers);
    }
    watchers.add(invalidate);
    if (!this.renderTimer) {
      this.renderTimer = setInterval(() => {
        for (const batchId of this.renderWatchers.keys()) this.notifyRender(batchId);
      }, 1e3);
      this.renderTimer.unref();
    }
  }
  finishRender(id) {
    this.notifyRender(id);
    this.renderWatchers.delete(id);
    if (!this.renderWatchers.size) this.stopRenderTimer();
  }
  status(ctx) {
    const selected = this.defaultModel;
    const availability = selected && ctx ? this.availableModels(ctx).some((model) => `${model.provider}/${model.id}` === selected) ? "available" : "unavailable in this Pi session" : void 0;
    return `Subagents: ${this.enabled ? "enabled" : "disabled"}; default model: ${selected ?? "inherit current Pi model"}${availability ? ` (${availability})` : ""}; running: ${this.activeRunners}; active batches: ${[...this.batches.keys()].join(", ") || "none"}. Background results return to the originating session.`;
  }
  assertModuleIdle(capability) {
    if ([...this.batches.values()].some(
      (batch) => batch.tasks.some(({ task }) => task.tools?.includes(capability))
    ))
      throw new Error(`Subagents are using ${capability}; cancel or wait for the batch before unloading.`);
  }
  releaseSlot() {
    const next = this.waiters.shift();
    if (next)
      next();
    else this.activeRunners--;
  }
  async slot(signal) {
    if (signal.aborted) throw new Error("Batch cancelled.");
    if (this.activeRunners < MAX_RUNNING) this.activeRunners++;
    else {
      await new Promise((resolve3, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", cancel);
          resolve3();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Batch cancelled."));
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", cancel, { once: true });
      });
      if (signal.aborted) {
        this.releaseSlot();
        throw new Error("Batch cancelled.");
      }
    }
    return () => this.releaseSlot();
  }
  tools() {
    return this.enabled ? [this.modelsTool(), this.callTool(), this.viewTool(), this.cancelTool()] : [];
  }
  availableModels(ctx) {
    const available = ctx.modelRegistry.getAvailable();
    const scoped = ctx.scopedModels?.length ? new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)) : void 0;
    return available.filter((model) => !scoped || scoped.has(`${model.provider}/${model.id}`));
  }
  modelsTool() {
    return {
      name: "view_subagent_models",
      label: "Subagent Models",
      description: "View models enabled and available in the current Pi session, including text/image input and reasoning metadata. Read-only, no model call. Use exact provider/model-id in call_subagents; omit model to use the saved subagent default or current Pi model.",
      parameters: ModelsSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const query = args.query?.toLowerCase() ?? "";
        const models = this.availableModels(ctx).filter(
          (model) => (!query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query)) && (!args.input || model.input.includes(args.input)) && (args.reasoning === void 0 || model.reasoning === args.reasoning)
        );
        const offset = args.offset ?? 0;
        const page = models.slice(offset, offset + PAGE_SIZE).map((model) => ({
          model: `${model.provider}/${model.id}`,
          name: model.name,
          input: model.input,
          reasoning: model.reasoning,
          thinking_levels: thinkingLevels(model),
          current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
          default: this.defaultModel === `${model.provider}/${model.id}`
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total: models.length,
                  default_model: this.defaultModel ?? null,
                  offset,
                  next_offset: offset + PAGE_SIZE < models.length ? offset + PAGE_SIZE : null,
                  models: page
                },
                null,
                2
              )
            }
          ],
          details: { total: models.length }
        };
      }
    };
  }
  callTool() {
    return {
      name: "call_subagents",
      label: "Call Subagents",
      promptSnippet: "Delegate substantial independent investigations, parallel subtasks, or useful second opinions to isolated Pi agents; handle trivial questions directly.",
      promptGuidelines: [
        "Consider call_subagents when independent or parallel work justifies extra model usage. Give each child self-contained context and only the tools it needs; wait for the background completion before relying on its findings."
      ],
      description: "Create 1\u20138 independent Pi agents in the background. Each task needs context; tools are optional (omitted = no tools). Model priority: explicit task.model, saved subagent default, current Pi model. Thinking inherits the current Pi session unless specified. Only models enabled in the current Pi session and tools active in the parent are allowed. Pi and pi-enhance write/effectful tools require explicit user approval; unknown extension tools are unsupported. No implicit timeout or turn limit. Results return as a separate session message after completion; no progress stream. Never retry side effects automatically.",
      parameters: CallSchema,
      renderCall: (args, theme) => new Text(
        [
          theme.fg("toolTitle", theme.bold("SUBAGENTS")) + theme.fg("muted", ` \xB7 launching ${args.tasks.length} task(s)`),
          ...args.tasks.map(
            (task, index) => theme.fg("accent", `  ${index + 1}. `) + theme.fg("dim", task.context.replace(/\s+/g, " ").slice(0, 100)) + (task.model ? theme.fg("muted", ` \xB7 ${task.model}`) : "")
          )
        ].join("\n"),
        0,
        0
      ),
      renderResult: (result, { expanded }, theme, context) => {
        const details = result.details;
        if (!details?.batchId)
          return new Text(
            theme.fg("warning", result.content.find((c) => c.type === "text")?.text ?? "Failed to start"),
            0,
            0
          );
        const batch = this.batches.get(details.batchId) ?? this.history.get(details.batchId);
        if (!batch)
          return new Text(
            theme.fg("muted", `Subagents \xB7 batch ${details.batchId} \xB7 no longer in this session`),
            0,
            0
          );
        if (this.batches.has(batch.id) && !context.state.subagentWatcher) {
          context.state.subagentWatcher = () => context.invalidate();
          this.watchRender(batch.id, context.state.subagentWatcher);
        }
        const now = Date.now();
        const elapsed = ((batch.finishedAt ?? now) - batch.createdAt) / 1e3;
        const completed = batch.states.filter((state) => state.status === "completed").length;
        const usage2 = batch.states.reduce(
          (total, state, index) => {
            const value = batch.results[index]?.usage ?? state.progress?.usage;
            total.input += value?.input ?? 0;
            total.output += value?.output ?? 0;
            total.cost += value?.cost ?? 0;
            return total;
          },
          { input: 0, output: 0, cost: 0 }
        );
        const lines = [
          theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", ` \xB7 ${batch.id}`),
          theme.fg(
            batch.finishedAt ? "success" : "warning",
            `${completed}/${batch.states.length} completed`
          ) + theme.fg(
            "muted",
            ` \xB7 ${elapsed.toFixed(1)}s \xB7 ${usage2.input} in / ${usage2.output} out \xB7 $${usage2.cost.toFixed(4)} settled`
          )
        ];
        for (let index = 0; index < batch.states.length; index++) {
          const state = batch.states[index];
          const latest = state.progress?.recent.at(-1);
          const seconds = state.startedAt ? ((state.finishedAt ?? now) - state.startedAt) / 1e3 : 0;
          lines.push(
            theme.fg(
              state.status === "completed" ? "success" : state.status === "failed" || state.status === "cancelled" ? "error" : "accent",
              `  ${index + 1}. ${state.status}`
            ) + theme.fg(
              "muted",
              ` \xB7 ${seconds.toFixed(1)}s${state.progress?.tool ? ` \xB7 ${state.progress.tool}` : ""}`
            )
          );
          if (expanded) {
            lines.push(
              theme.fg(
                "dim",
                `     ${state.id} \xB7 ${batch.results[index]?.usage.input ?? state.progress?.usage.input ?? 0} in / ${batch.results[index]?.usage.output ?? state.progress?.usage.output ?? 0} out`
              )
            );
            if (latest?.text)
              lines.push(
                theme.fg(
                  "dim",
                  `     ${latest.source}${latest.tool ? `/${latest.tool}` : ""}: ${latest.text.replace(/\s+/g, " ").slice(-180)}`
                )
              );
          } else if (latest?.text)
            lines.push(theme.fg("dim", `     ${latest.text.replace(/\s+/g, " ").slice(-100)}`));
        }
        return new Text(lines.join("\n"), 0, 0);
      },
      execute: async (_id, args, signal, _update, ctx) => {
        if (!this.enabled || this.closed) throw new Error("Subagents are disabled or the session has ended.");
        signal?.throwIfAborted();
        const models = this.availableModels(ctx);
        const active = new Set(this.pi.getActiveTools());
        const enhanced = new Set(this.registry.tools().map((tool) => tool.name));
        const approved = /* @__PURE__ */ new Set();
        const prepared = [];
        for (const task of args.tasks) {
          const requestedModel = task.model ?? this.defaultModel;
          const model = requestedModel ? models.find((m) => `${m.provider}/${m.id}` === requestedModel) : ctx.model && models.find((m) => m.provider === ctx.model?.provider && m.id === ctx.model?.id);
          if (!model)
            throw new Error(
              `Model ${requestedModel ?? "(current)"} is not enabled and available in this Pi session. Use view_subagent_models or change /pi-enhance subagents model.`
            );
          if (task.thinking_level && !thinkingLevels(model).includes(task.thinking_level))
            throw new Error(
              `Thinking level ${task.thinking_level} is unsupported by ${model.provider}/${model.id}.`
            );
          const names = task.tools ?? [];
          if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in one task.");
          for (const name of names) {
            if (HOST_TOOLS.has(name) || !active.has(name))
              throw new Error(`Tool ${name} is not active in the parent Pi session.`);
            if (!BUILTIN.has(name) && !enhanced.has(name))
              throw new Error(`Tool ${name} cannot be safely reconstructed in a child session.`);
            if (EFFECTFUL.has(name)) approved.add(name);
          }
          prepared.push({ task, model, thinking: task.thinking_level ?? ctx.thinkingLevel ?? "off" });
        }
        if (approved.size) {
          if (!ctx.hasUI)
            throw new Error(
              `Subagent write/effectful tools are blocked without interactive user approval: ${[...approved].join(", ")}.`
            );
          const ok = await ctx.ui.confirm(
            "Allow subagent side effects?",
            `These child agents may use ${[...approved].join(", ")}. Bash/PowerShell can bypass file restrictions; generation saves artifacts and can consume quota. Approve this batch only?`
          );
          if (!ok) throw new Error("Subagent write/effectful tools were not approved.");
        }
        signal?.throwIfAborted();
        if ([...this.batches.values()].reduce(
          (count, batch2) => count + batch2.tasks.length - batch2.results.filter(Boolean).length,
          0
        ) + prepared.length > MAX_QUEUED)
          throw new Error("Subagent queue is full; wait for existing batches to finish.");
        const owner = ctx.sessionManager.getSessionId();
        if (this.owner !== owner) throw new Error("Session changed while preparing subagents.");
        const batch = {
          id: randomUUID3(),
          createdAt: Date.now(),
          states: prepared.map(() => ({ id: randomUUID3(), status: "queued" })),
          owner,
          anchor: ctx.sessionManager.getLeafId(),
          sessionManager: ctx.sessionManager,
          controller: new AbortController(),
          tasks: prepared,
          modelRegistry: ctx.modelRegistry,
          results: []
        };
        this.batches.set(batch.id, batch);
        void this.run(batch).catch((error) => {
          this.finishRender(batch.id);
          this.batches.delete(batch.id);
          if (!this.closed && this.owner === owner && !batch.controller.signal.aborted)
            this.publish(
              batch,
              `Batch ${batch.id} failed: ${error instanceof Error ? error.message : String(error)}`
            );
        });
        return {
          content: [
            {
              type: "text",
              text: `Started ${prepared.length} subagent task(s); batch ${batch.id}; task IDs: ${batch.states.map((state) => state.id).join(", ")}. Continue other work. Use view_subagents to check progress or cancel_subagents to cancel. A completion message will be delivered to this session.`
            }
          ],
          details: {
            batchId: batch.id,
            taskIds: batch.states.map((state) => state.id),
            tasks: prepared.length
          }
        };
      }
    };
  }
  taskView(batch, index, full = false) {
    const state = batch.states[index];
    const result = batch.results[index];
    const now = Date.now();
    return {
      id: state.id,
      index: index + 1,
      status: state.status,
      phase: state.status === "running" || state.status === "cancelling" ? state.progress?.phase ?? "starting" : void 0,
      current_tool: state.status === "running" || state.status === "cancelling" ? state.progress?.tool : void 0,
      recent_output: state.progress?.recent?.filter((entry) => entry.text) ?? [],
      model: `${batch.tasks[index].model.provider}/${batch.tasks[index].model.id}`,
      context_preview: batch.tasks[index].task.context.replace(/\s+/g, " ").slice(0, 160),
      started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      elapsed_ms: state.startedAt ? (state.finishedAt ?? now) - state.startedAt : 0,
      turns: result?.turns ?? state.progress?.turns ?? 0,
      usage: result?.usage ?? state.progress?.usage ?? { input: 0, output: 0, cost: 0 },
      result: result ? result.text.slice(0, full ? OUTPUT_CHARS : PREVIEW_CHARS) : void 0,
      truncated: result ? result.text.length > (full ? OUTPUT_CHARS : PREVIEW_CHARS) : void 0
    };
  }
  batchView(batch, full = false) {
    return {
      batchId: batch.id,
      created_at: new Date(batch.createdAt).toISOString(),
      finished_at: batch.finishedAt ? new Date(batch.finishedAt).toISOString() : null,
      total: batch.states.length,
      counts: Object.fromEntries(
        ["queued", "running", "cancelling", "completed", "failed", "cancelled", "timeout", "max_turns"].map(
          (status) => [status, batch.states.filter((state) => state.status === status).length]
        )
      ),
      tasks: full ? batch.states.map((_, index) => this.taskView(batch, index)) : void 0
    };
  }
  viewTool() {
    return {
      name: "view_subagents",
      label: "View Subagents",
      description: "Read-only current-session progress. With no arguments, list batches; with batchId, show task progress; with id, show one task and its final result. Recent visible assistant text and tool output are bounded to three snippets of 500 characters; reasoning is never included. Completed batches are retained for this session (latest 24).",
      parameters: ViewSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batches = [...this.batches.values(), ...this.history.values()].filter(
          (batch) => batch.owner === ctx.sessionManager.getSessionId() && this.onBranch(batch)
        );
        let data;
        if (args.id) {
          const batch = batches.find((item) => item.states.some((state) => state.id === args.id));
          if (!batch || args.batchId && batch.id !== args.batchId)
            throw new Error("Subagent task not found in this session/branch.");
          data = {
            batchId: batch.id,
            task: this.taskView(
              batch,
              batch.states.findIndex((state) => state.id === args.id),
              true
            )
          };
        } else if (args.batchId) {
          const batch = batches.find((item) => item.id === args.batchId);
          if (!batch) throw new Error("Subagent batch not found in this session/branch.");
          data = this.batchView(batch, true);
        } else data = { batches: batches.map((batch) => this.batchView(batch)) };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }
    };
  }
  cancelTool() {
    return {
      name: "cancel_subagents",
      label: "Cancel Subagents",
      description: "Request cancellation of an active batch by batchId. Running tasks show cancelling until their model/tool acknowledges abort and settles; queued tasks are cancelled immediately. No automatic retry.",
      parameters: CancelSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batch = this.batches.get(args.batchId);
        if (!batch || batch.owner !== ctx.sessionManager.getSessionId() || !this.onBranch(batch))
          throw new Error("Active subagent batch not found in this session/branch.");
        this.cancel(args.batchId);
        return {
          content: [
            {
              type: "text",
              text: `Cancellation requested for batch ${args.batchId}. Use view_subagents to inspect final state.`
            }
          ],
          details: { batchId: args.batchId, cancelled: true }
        };
      }
    };
  }
  async run(batch) {
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_RUNNING, batch.tasks.length) }, async () => {
      while (next < batch.tasks.length && !batch.controller.signal.aborted) {
        const index = next++;
        const { task, model, thinking } = batch.tasks[index];
        let release;
        try {
          release = await this.slot(batch.controller.signal);
          const state = batch.states[index];
          if (batch.controller.signal.aborted) throw new Error("Batch cancelled.");
          state.status = "running";
          state.startedAt = Date.now();
          batch.results[index] = await this.runner(
            task,
            index,
            model,
            thinking,
            this.registry,
            batch.modelRegistry,
            batch.controller.signal,
            (progress) => {
              state.progress = progress;
              this.scheduleRender(batch.id);
            }
          );
          state.status = batch.controller.signal.aborted ? "cancelled" : batch.results[index].status;
          if (batch.controller.signal.aborted) batch.results[index].status = "cancelled";
          state.finishedAt = Date.now();
        } catch (error) {
          const state = batch.states[index];
          state.status = batch.controller.signal.aborted ? "cancelled" : "failed";
          state.finishedAt = Date.now();
          batch.results[index] = {
            index,
            model: `${model.provider}/${model.id}`,
            status: state.status,
            text: error instanceof Error ? error.message : String(error),
            turns: state.progress?.turns ?? 0,
            usage: state.progress?.usage ?? { input: 0, output: 0, cost: 0 }
          };
        } finally {
          release?.();
        }
      }
    });
    await Promise.all(workers);
    for (let index = 0; index < batch.states.length; index++) {
      const state = batch.states[index];
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      }
      if (!batch.results[index])
        batch.results[index] = {
          index,
          model: `${batch.tasks[index].model.provider}/${batch.tasks[index].model.id}`,
          status: "cancelled",
          text: "Cancelled before starting.",
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 }
        };
    }
    batch.finishedAt = Date.now();
    this.finishRender(batch.id);
    const stillTracked = this.batches.delete(batch.id);
    if (!stillTracked || this.closed || this.owner !== batch.owner || !this.onBranch(batch)) return;
    this.history.set(batch.id, batch);
    if (this.history.size > HISTORY_LIMIT) this.history.delete(this.history.keys().next().value);
    if (batch.controller.signal.aborted) return;
    const lines = batch.results.map(
      (result) => `### Task ${result.index + 1} \xB7 ${result.model} \xB7 ${result.status}
${result.text.slice(0, OUTPUT_CHARS)}${result.text.length > OUTPUT_CHARS ? "\n[Output truncated]" : ""}
Turns: ${result.turns}; tokens: ${result.usage.input} in / ${result.usage.output} out; cost: $${result.usage.cost.toFixed(4)}`
    );
    this.publish(batch, `Batch ${batch.id} completed.

${lines.join("\n\n---\n\n")}`);
  }
  onBranch(batch) {
    return batch.sessionManager.getSessionId() === batch.owner && (!batch.anchor || batch.sessionManager.getBranch().some((entry) => entry.id === batch.anchor));
  }
  publish(batch, content) {
    if (this.closed || !this.onBranch(batch)) return;
    this.pi.sendMessage(
      {
        customType: "pi-enhance:subagents",
        content,
        display: true,
        details: {
          batchId: batch.id,
          results: batch.results,
          taskIds: batch.states.map((state) => state.id),
          elapsedMs: (batch.finishedAt ?? Date.now()) - batch.createdAt,
          taskElapsedMs: batch.states.map(
            (state) => state.startedAt ? (state.finishedAt ?? Date.now()) - state.startedAt : 0
          )
        }
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }
};

// packages/hosts/pi/src/index.ts
var command = "pi-enhance";
var releaseGuidance = "When changing agent-enhance/pi-enhance for installation in Pi, follow the repository's docs/release.md: run checks, commit and push to https://github.com/Ezio2000/agent-enhance, then install or update Pi from that Git remote. Never persistently install the local working tree. If pushing is not authorized or fails, ask or stop rather than substituting a local installation.";
var support = /* @__PURE__ */ new Set(["approval", "task-settled", "request-interception"]);
function modelInfo(model) {
  if (!model) return;
  return {
    id: model.id,
    provider: model.provider === "openai-codex" ? "openai" : model.provider,
    channel: model.provider === "openai-codex" ? "codex" : void 0,
    api: model.api === "openai-codex-responses" ? "codex-responses" : model.api,
    input: model.input
  };
}
function executionContext(ctx) {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    host: "pi",
    model: modelInfo(ctx.model),
    credentials: new StaticCredentialResolver({}),
    signal: ctx.signal,
    history: piHistory(ctx.sessionManager.buildContextEntries()),
    choose: ctx.hasUI ? (title, choices, signal) => ctx.ui.select(title, choices, { signal }) : void 0
  };
}
function createPiEnhance(pi, options) {
  const store = new PreferenceStore(options.home, "pi", emptyPiPreferences, verifyRequestPreferences);
  let preferences = store.load();
  const registry = new CapabilityRegistry();
  const modules = new ModuleCatalog(options.catalog, options.moduleDirectory);
  const runtimeOptions = {
    modules,
    registry,
    services: (entry) => ({
      artifactRoot: join8(options.home, "artifacts", "pi", entry.capability, entry.provider),
      preview: (bytes, mime) => resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 })
    })
  };
  let runtime = new ServiceRuntime(runtimeOptions);
  const subagents = new Subagents(pi, registry);
  let previousProvider;
  let disposed = false, operations = new AbortController();
  let registered = /* @__PURE__ */ new Set();
  const knownNames = /* @__PURE__ */ new Set();
  let footerLabels = [];
  let currentContext, stopWatching;
  const sourceOptions = { home: options.home, nativePi: true };
  const sources = (ctx) => options.sources?.(ctx) ?? [piServiceSource(ctx), ...fileSources(sourceOptions)];
  const report = (ctx, text, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else {
      pi.sendMessage({ customType: "pi-enhance", content: text, display: true }, { triggerTurn: false });
      if (ctx.mode === "print") console.log(text);
    }
  };
  const statusLine = (ctx) => {
    const model = modelInfo(ctx.model);
    footerLabels = model?.provider === "openai" && model.channel === "codex" && model.api === "codex-responses" ? requestControls.filter((control) => control.supported(model)).map((control) => {
      const value = preferences.requests[control.id] ?? "off";
      return {
        id: control.id,
        value: control.formatValue?.(value, model) ?? value,
        active: value !== "off"
      };
    }) : [];
    if (ctx.hasUI)
      ctx.ui.setStatus(
        command,
        footerLabels.length ? footerLabels.map((l) => `${l.id}:${l.value}`).join(" ") : void 0
      );
  };
  const executeTool = async (tool, id, args, signal, update, ctx) => {
    try {
      return await tool.execute(id, args, signal, update, executionContext(ctx));
    } finally {
      scheduleSynchronization();
    }
  };
  const refresh = (ctx) => {
    const hostTools = subagents.tools();
    const tools = [...registry.tools(), ...hostTools];
    const active = new Set(pi.getActiveTools());
    for (const tool of tools) {
      const collision = pi.getAllTools().find((t) => t.name === tool.name);
      if (collision && !knownNames.has(tool.name))
        throw new Error(`Tool collision: ${tool.name}; disable the conflicting extension first.`);
      const hostTool = hostTools.find((candidate) => candidate.name === tool.name);
      if (hostTool) pi.registerTool(hostTool);
      else {
        const capabilityTool = tool;
        pi.registerTool({
          ...capabilityTool,
          execute: (id, args, signal, update, piContext) => executeTool(capabilityTool, id, args, signal, update, piContext)
        });
      }
      if (!registered.has(tool.name)) active.add(tool.name);
    }
    const available = new Set(tools.map((t) => t.name));
    for (const name of registered) if (!available.has(name)) active.delete(name);
    registered = available;
    for (const name of available) knownNames.add(name);
    pi.setActiveTools([...active]);
    statusLine(ctx);
  };
  const scheduleSynchronization = () => {
    const ctx = currentContext;
    if (!disposed && ctx)
      void synchronize(ctx).catch((error) => {
        if (!disposed && currentContext === ctx) report(ctx, String(error), true);
      });
  };
  const synchronize = async (ctx) => {
    if (disposed) return;
    currentContext = ctx;
    preferences = store.load();
    subagents.setEnabled(preferences.subagents.enabled);
    subagents.setDefaultModel(preferences.subagents.model);
    await runtime.synchronize(
      sources(ctx),
      preferences,
      { features: support, model: modelInfo(ctx.model) },
      operations.signal
    );
    if (!disposed && ctx === currentContext) refresh(ctx);
  };
  registerManagement(pi, {
    runtime: () => runtime,
    store,
    preferences: () => preferences,
    subagents,
    synchronize,
    refresh,
    report,
    signal: () => operations.signal
  });
  pi.on("session_start", async (_event, ctx) => {
    if (disposed) {
      operations = new AbortController();
      runtime = new ServiceRuntime(runtimeOptions);
    }
    disposed = false;
    previousProvider = ctx.model?.provider;
    preferences = store.load();
    subagents.setEnabled(preferences.subagents.enabled);
    subagents.setDefaultModel(preferences.subagents.model);
    subagents.startSession(ctx.sessionManager.getSessionId());
    await synchronize(ctx);
    stopWatching?.();
    stopWatching = watchServiceSources(
      [store.path, ...sourcePaths(sourceOptions), ...piSourcePaths()],
      scheduleSynchronization
    );
    installEnhanceFooter(ctx, command, () => footerLabels);
  });
  pi.on("model_select", async (event, ctx) => {
    const model = event.model ?? ctx.model;
    if (previousProvider !== void 0 && model?.provider !== previousProvider)
      await registry.lifecycle("provider_change");
    previousProvider = model?.provider;
    await synchronize({ ...ctx, model });
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return;
    const payload = transformControlledRequest(
      event.payload,
      modelInfo(ctx.model),
      requestControls,
      preferences.requests
    );
    if (payload !== event.payload) return payload;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    event.systemPromptOptions.sections.pi_enhance_release = releaseGuidance;
    await synchronize(ctx);
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
    await synchronize(ctx);
  });
  pi.on("session_tree", async () => {
    subagents.cancelAll();
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    stopWatching?.();
    currentContext = void 0;
    subagents.shutdown();
    operations.abort();
    try {
      await runtime.dispose();
    } finally {
      if (ctx.hasUI) {
        ctx.ui.setStatus(command, void 0);
        ctx.ui.setFooter(void 0);
      }
    }
  });
}
function piEnhance(pi) {
  const here = dirname4(fileURLToPath(import.meta.url));
  const dist = existsSync5(join8(here, "catalog.json")) ? here : join8(here, "../../../../dist");
  const catalog = JSON.parse(readFileSync3(join8(dist, "catalog.json"), "utf8"));
  createPiEnhance(pi, { home: enhanceHome(), catalog, moduleDirectory: join8(dist, "modules") });
}
export {
  createPiEnhance,
  piEnhance as default,
  executionContext,
  modelInfo
};
