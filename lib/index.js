'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.strToKey = undefined;

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

require('babel-polyfill');

var _pg = require('pg');

var _pg2 = _interopRequireDefault(_pg);

var _crypto = require('crypto');

var _debug = require('debug');

var _debug2 = _interopRequireDefault(_debug);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var debug = (0, _debug2.default)('advisory-lock');
var noop = function noop() {};

// Converts string to 64 bit number for use with postgres advisory lock
// functions
var strToKey = exports.strToKey = function strToKey(name) {
  // TODO: detect "in process" collisions?
  // Generate sha256 hash of name
  // and take 32 bit twice from hash
  var buf = (0, _crypto.createHash)('sha256').update(name).digest();
  return [buf.readInt32LE(0), buf.readInt32LE(1)];
};

// Patches client so that unref works as expected... Node terminates
// only if there are not pending queries
var patchClient = function patchClient(client) {
  var connect = client.connect.bind(client);
  var query = client.query.bind(client);
  var refCount = 0;

  var ref = function ref() {
    refCount++;
    client.connection.stream.ref();
  };
  var unref = function unref() {
    refCount--;
    if (!refCount) client.connection.stream.unref();
  };

  var wrap = function wrap(fn) {
    return function () {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      ref();
      var lastArg = args[args.length - 1];
      var lastArgIsCb = typeof lastArg === 'function';
      var outerCb = lastArgIsCb ? lastArg : noop;
      if (lastArgIsCb) args.pop();
      var cb = function cb() {
        unref();
        outerCb.apply(undefined, arguments);
      };
      args.push(cb);
      return fn.apply(undefined, args);
    };
  };

  client.connect = wrap(connect);
  client.query = wrap(query);
  return client;
};

var query = function query(client, lockFn, _ref) {
  var _ref2 = _slicedToArray(_ref, 2),
      key1 = _ref2[0],
      key2 = _ref2[1];

  return new _bluebird2.default(function (resolve, reject) {
    var sql = 'SELECT ' + lockFn + '(' + key1 + ', ' + key2 + ')';
    debug('query: ' + sql);
    client.query(sql, function (err, result) {
      if (err) {
        debug(err);
        return reject(err);
      }
      resolve(result.rows[0][lockFn]);
    });
  });
};

// Pauses promise chain until pg client is connected
var initWaitForConnection = function initWaitForConnection(client) {
  var queue = [];
  var waitForConnect = true;
  debug('connecting');

  client.connect(function (err) {
    waitForConnect = false;
    if (err) {
      debug('connection error');
      debug(err);
      queue.forEach(function (_ref3) {
        var _ref4 = _slicedToArray(_ref3, 2),
            reject = _ref4[1];

        return reject(err);
      });
    } else {
      debug('connected');
      queue.forEach(function (_ref5) {
        var _ref6 = _slicedToArray(_ref5, 1),
            resolve = _ref6[0];

        return resolve();
      });
    }
  });
  return function () {
    return new _bluebird2.default(function (resolve, reject) {
      if (!waitForConnect) return resolve();
      debug('waiting for connection');
      queue.push([resolve, reject]);
    });
  };
};

exports.default = function (conString) {
  debug('connection string: ' + conString);
  var client = patchClient(new _pg2.default.Client(conString));
  var waitForConnection = initWaitForConnection(client);
  // TODO: client.connection.stream.unref()?

  var createMutex = function createMutex(name) {
    var key = typeof name === 'string' ? strToKey(name) : name;

    var lock = function lock() {
      return query(client, 'pg_advisory_lock', key);
    };
    var unlock = function unlock() {
      return query(client, 'pg_advisory_unlock', key);
    };
    var tryLock = function tryLock() {
      return query(client, 'pg_try_advisory_lock', key);
    };

    // TODO: catch db disconnection errors?
    var withLock = function withLock(fn) {
      return lock().then(function () {
        return _bluebird2.default.resolve().then(fn).then(function (res) {
          return unlock().then(function () {
            return res;
          });
        }, function (err) {
          return unlock().then(function () {
            throw err;
          });
        });
      });
    };

    var tryWithLock = function tryWithLock(fn) {
      return tryLock().then(function (worked) {
        if (worked) {
          return _bluebird2.default.resolve().then(fn).then(function (res) {
            return unlock().then(function () {
              return res;
            });
          }, function (err) {
            return unlock().then(function () {
              throw err;
            });
          });
        }
        return _bluebird2.default.reject(new Error('Lock could not be obtained.'));
      });
    };

    var fns = { lock: lock, unlock: unlock, tryLock: tryLock, withLock: withLock, tryWithLock: tryWithLock };

    // "Block" function calls until client is connected
    var guardedFns = {};
    Object.keys(fns).forEach(function (fnName) {
      guardedFns[fnName] = function () {
        for (var _len2 = arguments.length, args = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
          args[_key2] = arguments[_key2];
        }

        return waitForConnection().then(function () {
          return fns[fnName].apply(fns, args);
        });
      };
    });
    return guardedFns;
  };
  createMutex.client = client;
  return createMutex;
};