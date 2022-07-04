# GINA - Installation

* * *

## Requirement
- node.js
- etc

- - -

## NPM
1. Start by create and/or going in the project folder.
`mkdir <project name>`
`cd <project name>`

2. Then install GINA with NPM.
`npm install gina`

![Command line image - install started](install-start.png)

At the end of npm install, you will see this :
![Command line image - install ended](install-end.png)

And for an empty folder, 3 new elements are created :
![Command line image - install result](install-result.png)

Congratulation, you have installed GINA.

- - -

## GIT
1. Start by create and/or going in the project folder.
`mkdir <project name>`
`mkdir <project name>/node_modules`
`cd <project name>/node_modules`

2. Then get GINA with GIT.
`git clone https://github.com/Rhinostone/gina.git`

![Command line image - install started](git-get.png)

3. Then start the post_install.js script to install Gina.
`cd gina`
`npm install`

![Command line image - install ended](git-install-start.png)

At the end of npm install, you will see this :
![Command line image - install ended](git-install-end.png)

After npm install, script/post_install.js will start and add 3 new elements at the project folder root :
![Command line image - install result](git-install-result.png)

Congratulation, you have installed GINA.