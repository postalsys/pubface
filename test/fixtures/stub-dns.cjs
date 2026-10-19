'use strict';

// Preloaded with --require into the CLI child processes of the tests, so that the PTR lookup
// of the resolved address never reaches real DNS. Works for both builds: an ES module import of
// node:dns gets this same object.

const dns = require('node:dns');

dns.promises.resolvePtr = async () => ['cli.example'];
