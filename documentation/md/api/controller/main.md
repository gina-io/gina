# Controller API

## Redirections

There are many ways to redirect in Gina.

### Redirecting thru `routing.json`

#### 1st method
adding the target to an existing route description
```
{
    "default": {
    	"comment": "default default index path",
        "url": [
        	"/",
            "",
            "/index.html",
            "default.js"
        ],
        "param": { "action": "home" }
    }
}
```

Let's say my project url is http://localhost:3000

This means that if i go to my browser and hit:
- http://localhost:3000
- http://localhost:3000/
- http://localhost:3000/index.html
- http://localhost:3000/default.js

For all these urls, only `localhost:3000/` will call the `home`action while the others will only be `301`redirections to the first element of our urls array.



NB.: The default redirect code applied will be `301`.

#### 2nd method
Creating a new route description

```
{
    "default": {
        "url": "/",
        "param": { "action": "home" }
    },
    "default-redirect": {
    	"comment": "will redirect to the route named [ default ] using 302 code"
        "url": [ "", "/index.html", "default.js" ],
        "param": {
            "action": "redirect",
            "route" : "default",
            "code" : 302
        }
    }
}

```

route (route name), url or (relative) path.
Redirect code (`301` by default)

### Redirecting from your controller

### Redirect types

route (route name), url or (relative) path.
TODO: keep_params option to forward query params (GET/POST/...)

Redirect code

## Forwarding
