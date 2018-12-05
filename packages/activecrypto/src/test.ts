import { Secured, ISecured, ADACType } from "./crypto/secured";

import {
  ActiveOptions,
  ActiveRequest,
  ActiveGZip,
  PouchDB
} from "../../activeoptions/lib";

let access: ISecured = {
  $ADAC: [
    {
      ref: "manual",
      type: ADACType.Node,
      roles: ["role1"]
    },
    {
      ref: "18640977f324c3bce055691e73853389167e6d40ccee73eb3e3d91957a4db736",
      type: ADACType.Stream,
      roles: ["role2"]
    },
    {
      ref: "manual",
      type: ADACType.Node,
      roles: ["role10"]
    }
  ],
  data: {
    $ADAR: "role1",
    top: "first level",
    nest: {
      first: "second",
      another: "one",
      test: {
        hello: "world",
        nest: {
          $ADAR: "role1",
          first: "second",
          another: "one",
          test: {
            hello: "world"
          }
        },
        nest2: {
          not: "encrypted",
          nor: "me"
        },
        invalid: {
          $ADAR: "role10",
          not: "encrypted",
          nor: "me"
        },
        nest3: {
          $ADAR: "role2",
          protected: "yes",
          images: "base64:4423423423984234kml23kj4hn234iuy234879u23n423478"
        }
      }
    }
  }
};

let self = {
  reference: "manual",
  public:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAgUBq5MuoazUvow0yoUx/\nGsI8M00Rldmof6kwFlsDNt5lbHIzPWRby5bDTr1lax6LOG5bcmklhP2hf5LSeBFW\nnPX4HGykyyh2ev5OoScsWfhd+oHz/8M0ZHnV1+5qYhrpWqOJKxevZgu11mBWep4x\noqwd3vJw1xWEBQjPVEm5Fde3CWf3ZQiV3qZZzccJb0SlJZSaUv5fEJgL+m+mykcO\n8K+s468WXTpcHj8/6YKwrkYmQosULmYkC5T/8pgoPOHOLdZ2TSDgvTjEhO53AWzn\nw3/sRmSxkA9FTEZkOHIHupQJoiGUlJkWzJ/AkqntkqOQgFuRiCHDJ+pMDMdHy5/q\nNQIDAQAB\n-----END PUBLIC KEY-----",
  private:
    "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCBQGrky6hrNS+j\nDTKhTH8awjwzTRGV2ah/qTAWWwM23mVscjM9ZFvLlsNOvWVrHos4bltyaSWE/aF/\nktJ4EVac9fgcbKTLKHZ6/k6hJyxZ+F36gfP/wzRkedXX7mpiGulao4krF69mC7XW\nYFZ6njGirB3e8nDXFYQFCM9USbkV17cJZ/dlCJXeplnNxwlvRKUllJpS/l8QmAv6\nb6bKRw7wr6zjrxZdOlwePz/pgrCuRiZCixQuZiQLlP/ymCg84c4t1nZNIOC9OMSE\n7ncBbOfDf+xGZLGQD0VMRmQ4cge6lAmiIZSUmRbMn8CSqe2So5CAW5GIIcMn6kwM\nx0fLn+o1AgMBAAECggEANkpgnAoPjDii8dIxWh9PpGXB86qDoHX0mOrwD/Pavclc\nwNiXPUpSZInHL+POHdiOkf2I293erKX8mCGL1nMx9mw683WPIua0HaWEUZyqvH/e\nucKsQtozv6CNek3i0aKMMk5O55LjUfHJR2rf6FFaeAHj6inby/x1n8e7jqQI4mtF\nZNM/BDOdO6qb8XY6s04RkmAii9huthsbzpCcpKiUk7pE5WjZqxF+RCCvjwK5f16s\nL7+KrMkQUS2ylErelZRlT5LOLOhkBW5IfPIheKPVqcgx1kCQyZww4mZ6t1sKIqu/\nngCaWc8rm3P9HYE6NCT6WxjbuoHtMtQLZz7VP7FKYQKBgQDhDfyF6X477Ukw7Utj\nJLLi4S0twlKbaxW7DQ9rxDYnKddtwzqxZfuP52Susnu9vOQpU2ltbLJTn2bnKUWs\n+cwQuHarkVOIWqM1oCCbcvNB9B6GBQW28gIOqSY+tNPGS3dJAj4VOBcghGvhOzhh\nFun+zFy1qm2WVdBTdo4wbP55swKBgQCTBiB9ZCfDEovidaD1SV8yrUmxpJTmjWMz\nTTuF5HbkY4kVGHDU+KEjWvIw8rWg3RIggrNMUvcFhWtKZARpjSgW2MR400AhkyTd\nuXsRiwDqzFmg5QWjGzcmbohnTRsnfaOv8YAGhKr6kpp16DxIgkeIVBFlBdNZo0tQ\nDAwKEPlIdwKBgGP7LbNkLuN6oChvUy2BcUNf3A1XJhHLugS2YaJzsccmTIGD2QBU\nmTSuDMmbm2OIlihR2SV2w6Zoy3Non36gHutSt82yq1SJR7acI8BLigxD4oeRlZ9X\n1lgjB02WUfrnLeAucdxFZejZS3/tKjff0SaULZ+7TiIaj4l0wuh6k3cHAoGAfzjA\nCIEQPybfUNjErTwOWoXEzSlDh7U08AGWzieCEeNnjY+Wo1N57GQYSu7a6BYkR2mR\nySvJgUeQLdEaWFPDKvHsITl7txHixtJngiisZIDr1eQX2qoEMQdYlTsNkkCP0gHB\n7OIEKcuOSRTqhTvmtjs4yhgeaOR6mQuzp0pEy8UCgYBZramreqHRuESJfVqcHpOi\nVNEKSffmNs6wIFWY2ba6EKRqgVAGrGN6uifAhG5HBwM+eYVlMDYfaiPjs+XWjq+s\nOxNoPbKBJ097uzqL7k0/gNhorIFETncOCWyNTqtnJd/XQ11LA/qX20WX7N0W6z6T\n5DHiv9pvKlggHfXozxGyZQ==\n-----END PRIVATE KEY-----"
};

ActiveOptions.init();
ActiveOptions.parseConfig();

// Self hosted data storage engine
if (ActiveOptions.get<any>("db", {}).selfhost) {
    // Rewrite config for this process
    ActiveOptions.get<any>("db", {}).url =
      "http://localhost:" +
      ActiveOptions.get<any>("db", {}).selfhost.port;
  }

let db = ActiveOptions.get<any>("db", {});

console.log(db);

// Create connection string
let dbc = new PouchDB(db.url + "/" + db.database);

let secured = new Secured(dbc, 2, self);
secured
  .encrypt(access)
  .then(res => {
    console.log(JSON.stringify(res, null, 2));
    console.log("=======================");
    console.log("=======================");
    console.log("=======================");
    secured
      .decrypt(res)
      .then(res2 => {
        console.log(JSON.stringify(res2, null, 2));
      })
      .catch(e => {
        console.log(e);
      });
  })
  .catch(e => {
    console.log(e);
  });
