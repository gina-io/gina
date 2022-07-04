# GINA

* * *

## Requirement
- node.js
- etc

* * *

## Commands

/!\ To use GINA in command line, the terminal must have the administrator right. /!\

- help :
	`gina -h | --help`
![Command line image - project init](help.png)

- version :
	`gina -v | --version`
![Command line image - project init](version.png)

- init :
	`gina -i | --init <project_name>`
![Command line image - project init](init-project.png)

- build :
	`gina -b | --build [bundle name]`

- add :
	`gina -a | --add <bundle name> [arguments]`
![Command line image - bundle added](add-bundle.png)
![Command line image - bundle result](add-bundle-result.png)

- delete :
	`gina -d | --delete <bundle name>`
![Command line image - bundle removed](delete-bundle.png)

- restart :
	`gina -r | --restart <bundle name>`

- start :
	`gina -s | --start <bundle name> [mode] [options]`
	- dev :
		`gina -s <bundle name> dev`
![Command line image - bundle removed](start-bundle.png)
Default IP (localhost), default port and default routes :
![Command line image - bundle removed](start-bundle-result.png)
To close the process, ctrl+C :
![Command line image - bundle removed](start-bundle-stop.png)
	- prod :
		`gina -s <bundle name> prod`
	- staging :
		`gina -s <bundle name> ???`
	- debug :
		`gina -s <bundle name> <mode> --debug-brk=<port>`