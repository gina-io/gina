## Debuging your test with nodeunit

```tty
 node --inspect-brk=6959 `which nodeunit` ./test/01-find.js
```

Options can be passed through routing or manually when writing to cache

```json
{
    "cache": {
        // Static cache from `memory` access or from `fs` access (file sytem)
        "type": "memory",
        "ttl": 3600,
        // Only active when set to `true`, default is `false`
        "sliding": true
    }
}
```