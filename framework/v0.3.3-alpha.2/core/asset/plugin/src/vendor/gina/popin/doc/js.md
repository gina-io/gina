[HTML5 Boilerplate homepage](https://html5boilerplate.com) | [Documentation
table of contents](TOC.md)

# The JavaScript

Information about the default JavaScript included in the project.

## main.js

This file can be used to contain or reference your site/app JavaScript code.
For larger projects, you can make use of a JavaScript module loader, like
[Require.js](http://requirejs.org/), to load any other scripts you need to
run.

## plugins.js

This file can be used to contain all your plugins and other 3rd party scripts.

By default the `plugins.js` file contains a small script to avoid `console`
errors in browsers that lack a `console`. The script will make sure that, if
a console method isn't available, that method will have the value of empty
function, thus, preventing the browser from throwing an error.


## vendor

This directory can be used to contain all 3rd party library code.
