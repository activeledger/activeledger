import { Secured, ISecured, ADACType } from "./crypto/secured";

let access: ISecured = {
  $ADAC: [
    {
      ref:
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1KuJf9kVGFNZi1s9jJv+\nbYotIo2QFYEFxG2dJ90zjuQH6TSOr04+l8TXuFqpRu3GqKRJot5LCWwOMEIgu5DZ\nRDrF8d6XtPDomT+Sbptjl4MuXIp9ajve5XMMq1PB8XWmn/tQcnrwOZsULaadUPei\nAj4JxwtCoHhrD1O6JxsLLviZ8VehvkyLOHot6AP+IgiY7TAV0QvE94Br4zK/SfIR\nRwM3waGNvsMg/XmBzWNrDR8xIwDfM6JlEPANOjODp3aB9XgXmL2RHOO2RdOrVdFl\n4y4g7uSwxnZCeygMCdoQlBEhxr8/ylCYZbZyzpHX5W/UVp85gW4EpRTpyV6ymSWJ\nwwIDAQAB\n-----END PUBLIC KEY-----",
      type: ADACType.PubKey,
      roles: ["role1"]
    },
    {
      ref:
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1KuJf9kVGFNZi1s9jJv+\nbYotIo2QFYEFxG2dJ90zjuQH6TSOr04+l8TXuFqpRu3GqKRJot5LCWwOMEIgu5DZ\nRDrF8d6XtPDomT+Sbptjl4MuXIp9ajve5XMMq1PB8XWmn/tQcnrwOZsULaadUPei\nAj4JxwtCoHhrD1O6JxsLLviZ8VehvkyLOHot6AP+IgiY7TAV0QvE94Br4zK/SfIR\nRwM3waGNvsMg/XmBzWNrDR8xIwDfM6JlEPANOjODp3aB9XgXmL2RHOO2RdOrVdFl\n4y4g7uSwxnZCeygMCdoQlBEhxr8/ylCYZbZyzpHX5W/UVp85gW4EpRTpyV6ymSWJ\nwwIDAQAB\n-----END PUBLIC KEY-----",
      type: ADACType.PubKey,
      roles: ["role2"]
    },
    {
      ref:
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1KuJf9kVGFNZi1s9jJv+\nbYotIo2QFYEFxG2dJ90zjuQH6TSOr04+l8TXuFqpRu3GqKRJot5LCWwOMEIgu5DZ\nRDrF8d6XtPDomT+Sbptjl4MuXIp9ajve5XMMq1PB8XWmn/tQcnrwOZsULaadUPei\nAj4JxwtCoHhrD1O6JxsLLviZ8VehvkyLOHot6AP+IgiY7TAV0QvE94Br4zK/SfIR\nRwM3waGNvsMg/XmBzWNrDR8xIwDfM6JlEPANOjODp3aB9XgXmL2RHOO2RdOrVdFl\n4y4g7uSwxnZCeygMCdoQlBEhxr8/ylCYZbZyzpHX5W/UVp85gW4EpRTpyV6ymSWJ\nwwIDAQAB\n-----END PUBLIC KEY-----",
      type: ADACType.PubKey,
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

let secured = new Secured();
secured
  .encrypt(access)
  .then(res => {
    console.log(JSON.stringify(res, null, 2));
  })
  .catch(e => {
    console.log(e);
  });
