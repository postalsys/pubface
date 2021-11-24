# pubface

Detect public network interfaces for current machine.

### Usage as a module

Install the dependency

```
$ npm install pubface
```

Use it to get an array of interfaces

```js
const { resolvePublicInterfaces } = require('pubface');
...
let interfaces = await resolvePublicInterfaces();
console.log(interfaces);
```

### Usage as a command

Install the command

```
$ npm install -g pubface
```

Or alternatively download the latest executable if you do not have Node.js or NPM installed

-   [MacOS](https://github.com/postalsys/pubface/releases/latest/download/pubface.pkg)
-   [Linux](https://github.com/postalsys/pubface/releases/latest/download/pubface.tar.gz)
-   [Window](https://github.com/postalsys/pubface/releases/latest/download/pubface.exe)

Use it to get an array of interfaces

```
$ pubface
```

### Output

Output is an array of interfaces:

```
[
  {
    "localAddress": "192.168.3.4",
    "ip": "1.2.3.4",
    "name": "ec2-1-2-3-4.eu-central-1.compute.amazonaws.com",
    "family": "IPv4",
    "defaultInterface": true
  },
  {
    "localAddress": "10.240.128.227",
    "ip": "101.102.103.104",
    "name": "104-103-102-101.sta.estpak.ee",
    "family": "IPv4"
  }
]
```

-   **localAddress** is the local IP address
-   **ip** is the public IP address that servers see as your IP address when you make a connection
-   **name** is the reverse record for **ip**
-   **family** is either _IPv4_ or _IPv6_ depending on the **ip**
-   **defaultInterface** is a boolean that indicates if this is the default interface used when making connections and not specifying a local address

## License

**MIT**
