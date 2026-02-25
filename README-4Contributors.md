# The contributor's guide
> This is a document is a work in progress.
> If you would like to contribute, you can contact us at `contact@gina.io`

### Installing Gina
---

You __cannot__ just install the framework with the `NPM` CLI. You will need to fetch/fork sources from the [github page](https://github.com/Rhinostone/gina) since all files are not published to `NPM`.



| Requirements | Description
|--------|--------|
| OS | Mac OS X or Linux |
| Node js       |   Node js v16.x or later     |
| NPM      |   v8.x or later     |
| Changie | v v1.24.x or later |



__NB.:__ Gina is meant to be install globaly
> [A Note on Permissions](http://npm.github.io/installation-setup-docs/installing/a-note-on-permissions.html)
> [Alternatives to installing npm packages globally](https://2ality.com/2022/06/global-npm-install-alternatives.html)


#### Check your prefix



```tty
npm config get prefix --quiet
```

> Default `prefix` should be:
> For libraries `/usr/local`

Targeted folder should be: `${global_prefix}/lib/node_modules/gina`
Make sure you have the appropriate permissions to write.

#### Clone gina

Then go to `${global_prefix}/lib/node_modules` in order to clone the project
```tty
cd ${global_prefix}/lib/node_modules
```

```tty
git clone https://github.com/Rhinostone/gina.git gina
```

```tty
cd gina && git checkout develop
```

#### Complete installation

Run the `pre installation script` in order to setup permissions
```tty
node ./script/pre_install.js
```

Then run the `post installation script`
```tty
node ./script/post_install.js
```

Check if everything is working fine
```tty
gina version
```

Starting the framework

```tty
gina start
```
Or in debug mode

```tty
gina start --inspect-gina
```

Retrieve logs

```tty
gina tail --follow
```

#### Setting the framework default environment

> By default, Gina comes with 2 environments : `dev` and `prod`. The default is `prod`. But if you are contributing to the framework we advise you you to use the `dev` environment: you will get a lot of debug messages, but it is easier to track what is being done in background.

__Changing default env__
By default, Gina is installed with `dev` environment which allow you to display the toolbar.
If you need to change this:
```tty
gina framework:set --env=prod
```

This only means that if you omit the env in the command line while trying to start the framework, it will automatically add `--env=prod` for you.

> __NB:__ Unlike for the projects `envs`, the framework env list cannot be changed; it is `dev` or `prod`.

### Building
> __NB.:__ Default environment is `prod`.

```tty
gina build --env=dev
```

### Debugging

#### Framework
```tty
gina start --inspect-gina
```

#### Bundles

> gina bundle:restart {bundle_name} @${project_name} --inspect=<port_number>

```tty
gina bundle:restart <bundle_name> @<project_name> --inspect=<port_number>
```



### Publishing
---


### Troubleshooting
---