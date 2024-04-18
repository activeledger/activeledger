# Activecrypto库

Activeledger支持多种加密方式并提供加密库Activecryto。Activecryto提供哈希加密，基础的密钥生成和签名工具，这些功能可以用在你自己的项目中。

## Typescript Signing Example 签名工具使用案例

请确认您已经安装了Activecryto模块

```bash
npm install @activeledger/activecrypto
```

现在我们可以创建一个基础方程来更简单的使用Activecryto并用此来搭建我们的应用。

```typescript
import { ActiveCrypto } from "@activeledger/activecrypto";

class Cryptography {

  /**
  * Sign data with PEM provided Key. PEM密钥导入数据
  *
  * @static
  * @param {any} data 数据
  * @param {any} key 密钥
  * @returns {Promise<string>}
  */
  public static sign(data: any, key: any): Promise<string> {
      // Get ActiveCrypto Object 获取ActiveCryto对象
      const keyPair = new ActiveCrypto.KeyPair(
        key.encryption,
        key.prv.pkcs8pem
      );

      // return signed data 返回写入数据
      return keyPair.sign(data)
    });
  }
}
```

现在我们可以在应用中调用这个class。

```typescript
// Obtain our key. (new lines are important) 获取密钥（格式很重要）
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

// Get Signature, Put into transaction 获取签名，导入数据
transaction.$sigs[[input stream]] = Cryptography.sign(transaction, key);

// Transaction Ready
```
