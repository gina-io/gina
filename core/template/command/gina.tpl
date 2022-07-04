#!/usr/bin/env node
/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Add to your ~/.batch_profile the following line
 *
 *  alias gina="/usr/local/bin/node gina $@"
 */

var fs = require('fs');

try {
    require('./node_modules/gina/node_modules/colors');
    var utils = require("./node_modules/gina/core/utils");
    var console = utils.logger;
    console.log('Gina I/O Command Line Tool \r\n'.rainbow);
    utils.cmd.load(__dirname, "/node_modules/gina/package.json")
} catch (err) {
    process.stdout.write(err.stack + '\r\n')
}