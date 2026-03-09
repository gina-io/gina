gina-dev(1) -- Command line interface
=============================================

## NAME

**gina dev**

## SYNOPSIS

**gina dev** [ **option** ]

or

**gina f**:[ **task** ] [ **arguments** ]


## DESCRIPTION
**gina framework** alows you to perform tasks on the framework and its services.

## OPTIONS

**-h**, **--help** Prints help for **gina dev** command.

## TASKS

**man**

    Generate manpage.


## ARGUMENTS



## EXEMPLE

**gina dev**'s command line only works if the framework is running.

e.g. Generate and link manpages using groff and html style.

~~~ tty
$ gina dev:man --groff --html=/custom/path
~~~




## AUTHOR

Martin-Luther ETOUMAN was the original author of **gina-dev**. Stephane HEAV joined the project since version 0.1.0.

## COPYRIGHT
Copyright (c) 2009-{year} Rhinostone <{email}>

## SEE ALSO

**gina**(1), **gina-project**(1), **gina-bundle**(1), **gina-model**(1)

## COLOPHON

This page is part of release {version} of the **gina** project. A description of the project,
and informations about reporting bugs can be found on the official web site: <http://www.gina.io/>

The project is also on GitHub: <https://github.com/rhinostone/gina>

Here is the mailling list: <https://groups.google.com/forum/#!forum/ginajs>
