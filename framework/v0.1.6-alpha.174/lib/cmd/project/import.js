// alias to Add
/**
 * Importe an existing bundle to a given project.
 * NB.: If bundle exists, You will be asked if you want to replace.
 *
 * Usage:
 * $ gina bundle:import <bundle_name> @<project_name>
 * or
 * $ gina bundle:add <bundle_name> @<project_name> --start-port-from=<port_number>
 * */
module.exports = require('./add')