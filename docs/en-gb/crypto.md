# Activecrypto

Activeledger is designed to operate with multiple cryptographic functions and this library provides the abstraction layer. You can use Activecrypto in your own projects as it provides Hashing, basic key generation and signing functions for your consumption.

## Typescript Signing Example 

Make sure you have installed activecrypto into your project

```bash
npm install @activeledger/activecrypto
```

Next we will create a basic class to make consuming activecrypto easier and more portable within our application.

```typescript
import { ActiveCrypto } from "@activeledger/activecrypto";

class Cryptography {

  /**
  * Sign data with PEM provided Key.
  * 
  * @static
  * @param {any} data 
  * @param {any} key 
  * @returns {Promise<string>}
  */
  public static sign(data: any, key: any): Promise<string> {
      // Get ActiveCrypto Object
      const keyPair = new ActiveCrypto.KeyPair(
        key.encryption,
        key.prv.pkcs8pem
      );
		
      // return signed data
      return keyPair.sign(data)
    });
  }
}
```

Now we need to consume the class within out application

```typescript
// Obtain our key. (new lines are important)
const key: any = {
    encryption: "secp256k1",
    prv: {
        pkcs8pem: `-----BEGIN PRIVATE-----
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxx
-----END PRIVATE-----`
    }
}

// Create the transaction object that needs to be signed
let transaction: any = {
    $tx: {
    	$namespace: "example",
    	$contract: "test",
    	"$i": {
        	"[input stream]": {}
    	}
    },
    $sigs: {}
}

// Get Signature, Put into transaction
transaction.$sigs[[input stream]] = Cryptography.sign(transaction, key);

// Transaction Ready
```

