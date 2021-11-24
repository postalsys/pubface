#!/usr/bin/env node

'use strict';

const { resolvePublicInterfaces } = require('../index.js');
resolvePublicInterfaces()
    .then(results => {
        console.log(JSON.stringify(results, false, 2));
        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
