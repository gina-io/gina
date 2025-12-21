gina(1) -- CLI
=============================================

## NAME
**gina**

## SYNOPSIS
**gina**	[ **option** ]
**gina**	[ **assetic**:**task**] [ **arguments** ]
**gina**	[ **assetic**:**task**] [ **service** ] [ **arguments** ]

## DESCRIPTION
Gina is a MVC & Events Driven Framework that allows you to create.

## OPTIONS
**-v**, **--version**			Prints current framework version.

**-h**, **--help**			   Prints.

## ASSETICS
env
framework
project
bundle
model
dev
view

## ENVIRONMENT

**--version** | **GINA_VERSION**
		Will override the default framework **version** used by Gina.

**--env** | **GINA_ENV**
    	Will override the runtime environment.

**--node-version** | **GINA_NODE_VERSION**
    	Will override the **Node.js** version, the binary used by Gina.
        More than one version at the time can be used.

**--debug-brk** | **GINA_DEBUG_BRK**

**--logs-path** | **GINA_LOGS_PATH**

**--tmp-path** | **GINA_TMP_PATH**

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

Martin-Luther ETOUMAN was the original Author of **gina**. Stephane HEAV joined the project since version 0.1.0.

## COPYRIGHT
Copyright (c) 2009-{year} Rhinostone <{email}>

## SEE ALSO

**gina-env**(1), **gina-framework**(1), **gina-project**(1), **gina-bundle**(1), **gina-model**(1), **gina-dev**(1)

## COLOPHON

This page is part of release {version} of the **gina** project. A description of the project,
and informations about reporting bugs can be found on the official web site: <http://www.gina.io/>

The project is also on GitHub: <https://github.com/rhinostone/gina>

Here is the mailling list: <https://groups.google.com/forum/#!forum/ginajs>
