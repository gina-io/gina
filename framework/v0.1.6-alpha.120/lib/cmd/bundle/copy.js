/**
 * Copy and insall the source bundle into another existing project
 *
 * - throw error if project does not exist
 * - setup:
 *      * ~/.gina/ports.json
 *      * ~/.gina/portsReverse.json
 *      * update ports on /new/path/to/project/env.json
 *      * update infos on /new/path/to/project/manifest.json
 *      * No cleanup needed since it's only a copy !
 *
 * The main advantage you are gaining over a simple copy/paste is that gina is going to
 * write configuration/settings for you.
 *
 * */