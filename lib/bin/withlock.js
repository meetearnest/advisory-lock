#!/usr/bin/env node
'use strict';

var _ = require('../');

var _2 = _interopRequireDefault(_);

var _minimist = require('minimist');

var _minimist2 = _interopRequireDefault(_minimist);

var _child_process = require('child_process');

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var errExit = function errExit(msg) {
  console.error(msg);
  process.exit(1);
};

var getConnectionString = function getConnectionString(args) {
  if (args.db) return args.db;
  if (!('PG_CONNECTION_STRING' in process.env)) {
    errExit('PG_CONNECTION_STRING not found and no --db argument passed');
  }
  return process.env.PG_CONNECTION_STRING;
};

var args = (0, _minimist2.default)(process.argv.slice(2), { '--': true });

if (args._.length < 1) {
  errExit('No <lockName> specified');
}
if (args._.length > 1) {
  errExit('Unknown arguments: ' + args._.slice(1));
}
if (!args['--'] || !args['--'].length) {
  errExit('No <command> specified');
}

var command = args['--'][0];
var commandArgs = args['--'].slice(1);
var connectionString = getConnectionString(args);
var lockName = args._[0];

var getChild = function getChild() {
  return (0, _child_process.spawn)(command, commandArgs, {
    stdio: 'inherit'
  });
};

var createMutex = (0, _2.default)(connectionString);
var mutex = createMutex(lockName);

mutex.withLock(function () {
  return new _bluebird2.default(function (resolve, reject) {
    console.log('Lock acquired');
    console.log(command, commandArgs);
    var child = getChild();
    child.on('error', reject);
    child.on('exit', resolve);
  });
}).catch(errExit).then(function (exitCode) {
  process.exit(exitCode);
});