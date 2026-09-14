gina-framework(1) -- Framework CLI
=============================================

## SYNOPSIS

**gina framework** [ **option** ]

**gina framework**:[ **task** ] [ **service** | **arguments** ]

**gina framework**:[ **task** ] [ **service**] [ **arguments** ]


## DESCRIPTION
**gina framework** alows you to perform tasks on the framework and its services.

## OPTIONS

**-t**, **--status**
		Get status of the framework.

**-h**, **--help**
		Prints help for **gina framework** command.

## TASKS

**-s**, **start**
		Starts the framework.

**-k**, **stop** | **kill**
		Stops the framework.

**-r**, **restart**
    	Restarts the framework.

**-u**, **update**
    	Reconcile the ~/.gina state files (main.json, settings.json) to the installed framework version. Dry-run by default; pass --fix to apply.

**add**
    	Install a published gina version side-by-side so a bundle can pin it via --gina-version. Downloads from npm, installs its deps, archives + symlinks it, and registers it in main.json. Additive — never changes the default version. Pass --dry-run to preview, --force to overwrite an existing archived copy.

**list**
    	List the framework versions known to this install: the active version, side-by-side symlinked versions, and archived copies. Pass --all to include versions registered in main.json but not on disk, --format=json for machine output.

**remove**
    	Remove a side-by-side installed version: unlinks it from the active install, deletes its archived copy, and deregisters it from main.json. Refuses to remove the active default or the real shipped version. Pass --force to remove a version a bundle still pins, --dry-run to preview.

**-e**, **set**
		Set environment variables


## ENVIRONMENT ARGUMENTS

**--version=val**
    	Tells Gina to run services with a specific framework version.

e.g. Start Gina using v0.1.5 of the framework

~~~ tty
$ gina framework:start --version=0.1.5
~~~

> N.B.: This will override default settings. See `gina-framework` manpage.

**--env=val**
    	Tells Gina to run services with a specific framework environment.

e.g. Runs the framework with development environment
~~~tty
$ gina framework:start --env=dev

~~~

**--node-version=val**
    	It is the **Node.js** version, the binary used by Gina.
        More than one version at the time can be used.

## EXEMPLE

**gina**'s command line only works if the framework is started.
You can start the framwork this way

~~~ tty
$ gina framework:start
~~~
or by using the alias
~~~ tty
$ gina start
~~~


## AUTHOR

Martin Luther ETOUMAN NDAMBWE was the original Author of **gina**. Stephane HEAV joined the project since version 0.1.0.

## COPYRIGHT
Copyright (c) 2009-{year} Rhinostone <contact@gina.io>

## SEE ALSO

**gina**(1), **gina-project**(1), **gina-bundle**(1), **gina-model**(1)

## COLOPHON

This page is part of release {version} of the **gina** project. A description of the project,
and informations about reporting bugs can be found on the official web site: <https://gina.io/>

The project is also on GitHub: <https://github.com/gina-io/gina>

Here is the mailling list: <https://groups.google.com/g/ginajs>
