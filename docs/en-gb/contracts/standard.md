# Standard Contracts

Your standard contract requires 3 functions within its class the functions. The standard contracts provides a lot of helper functions for you to consume as a contract developer.

#### Contract Entry Points

```typescript
public abstract verify(selfsigned: boolean): Promise<boolean>;
```

Verify allows the smart contract to validate that it understands the transaction. If verify rejects the transaction this stops the transaction from propagating around the network. The selfsigned parameter is there for when a transaction is provided when self signing. This is useful for automated self onboarding where the signature is provided with the public key in the same transaction.  

```typescript
public abstract vote(): Promise<boolean>;
```

Vote is where the consensus agrees that it is happy with the current transaction. This is where you would verify if the sender is able to send the funds for example. Returning false here doesn't interrupt the network as it could be that your data state has been modified by a system administrator.

```typescript
public abstract commit(possibleTerritoriality?: boolean): Promise<any>;
```

When consensus has been reached the commit phase is started. The commit phases is where you make the data changes to the state and confirm them to the ledger. 

##### Getting Started

You need to extend  & define your class as :

```typescript
export default class [name] extends Standard {
	public verify(selfsigned: boolean): Promise<boolean> { 
    	return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }

    public vote(): Promise<boolean> { 	   
        return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }

 	public commit(): Promise<any> {
 	    return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }
}
```

This is what the start of all smart contracts will look like. This is a valid contract however it doesn't do anything useful or change any data states.

#### Creating an example contract

In this example we will be creating a smart contract which will transfer funds from one persons account to another. We will assume the funds have already been deposited however we will verify that they have the right amount of funds to transfer.

##### Creating a verify function

As we will be working with existing identities on the ledger we will not be allowing self signed transactions. The transaction data packet is available in

```typescript
this.transactions...
```

As the contract developer you have full control over the contents of the transactional packet data. There are a few tricks to remember such as the $ prefix in the transaction body indicates an Activeledger property however you are not restricted from using it. [Learn more](../transactions.md)

```typescript
 public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!selfsigned && Object.values(this.transactions.$i)[0].transfer ) {     	
        resolve(true);
      } else {
        reject("Signatures Needed");
      }
    });
  }
```

Here we have confirmed the contract doesn't support self signing and the contract has verified the existing of the transfer amount.

##### Creating a vote function

Now we need to verify the actual funds are available from the input stream to give to the output stream.

```typescript
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Get the input to verify
      let iStreams = Object.keys(this.transactions.$i);

      // Fetch first input
      this.iActivity = this.getActivityStreams(iStreams[0]);

      // Get Input State
      let state = this.iActivity.getState();

      // Input Balance Transaction Values
      this.txValue = this.transactions.$i[iStreams[0]];

      // Are they trying to transfer more than they have
      if(this.txValue.transfer > state.amount) {
		reject("Not enough funds");
      }else{
		resolve(true);
      }      
    });
  }
```

When we reject the promise the message we provide is returned as the transaction response. 

##### Creating a commit function

With this commit function we will be deduction the transfer amount from the input and increase the balance on the output stream.

```typescript
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      	// Get the output stream from transaction
      	let oStreams = Object.keys(this.transactions.$o);
      
      	// Fetch first output
      	let oActivity = this.getActivityStreams(oStreams[0]);
      
      	// Input State
      	let iState = this.iActivity.getState();
      
        // Output State
        let oState = oActivityStream.getState();        

        // Increase output state balance by the transfer amount
      	oState.amount += this.txValue.transfer;        

      	// Decrease input state balance by the transfer amount
      	iState.amount -= this.txValue.transfer;
      
        // Update States
      	oActivity.setState(oState);
      	iActivity.setState(iState);       

        // Return
        resolve(true);
    });
  }
```

During this commit phase we have update the state object and passed the signal back to Activeledger that the contract has completed. As a contract developer all you have to focus on is your data and Activeledger will do the rest. 

#### What are Activities & Streams

These are Activeledger concepts in how data is manipulated and stored. An activity means a change of the ledger and the stream defines how the data is stored. As a transaction is both an activity and stream as it is applying an action and potentially update the data.

A smart contract on Activeledger is the main Activity provider and itself extends an internal class which providers these helpers to you.

#### Inherited Helpers

These are the helper functions added to the standard smart contract to assist in development.

````typescript
public newActivityStream(name: string): Activity;
````

Creates a new stream of data.

````typescript
public getActivityStreams(): { [reference: string]: Activity };
public getActivityStreams(stream: any): Activity;
````

Returns all or a specific Activity Stream(s) related to the current transaction (\$i and \$0)

```typescript
public getMofSignatures(m: number): boolean;
```

As Activeledger handles signature validation for you this allows you to do a basic multi signature test so your contract can apply different actions. For example you would be able to run different logic such as :

* 1 of 3 - Deny transfer
* 2 of 3 - Apply transfer
* 3 of 3 - Apply transfer and issue new balance

```typescript
public getReadOnlyStream(name: string): any;
```

Accessible in the transaction packets \$r property this allows you to read just the data stream of an activity. As \$r is not indicating any activities so no signature matching needs to take place you are able to make a name based reference.

```typescript
this.setTimeout(15000)
```

Increase the timeout of this smart contracts execution by an additional 15 seconds

```typescript
this.isExecutingOn(host:string): boolean;
```

Is the current smart contract process running on this specific node of the network.

```typescript
this.throw(location: string): void;
```

Resubmit the current processing transaction to this node in another ledger.

##### Inter Node Communication (INC)

This feature allows you to past messages between all nodes in the network processing this transaction.

```typescript
protected getInterNodeComms(): ActiveDefinitions.ICommunications
```

Get any data object communication from other nodes on the network.

```typescript
protected setThisInterNodeComms(data: object): void
```

Set the data this node will send on to other nodes processing this transaction.

```typescript
public getThisInterNodeComms(secret: number): object
```

Fetch the message the current node is broadcast for this transaction.

#### Activity Helpers

A contract works on the data as an Activity as above show with new & get activity stream. These are the helper functions attached to the returned values.

```typescript
public hasSignature(): boolean
```

Does this activity provide a signature for this transaction.

```typescript
public getAuthority(type: boolean = false): string
```

Get the identity who has signing authority. Providing type switch will expose what cryptographic function is providing the signature. 

```typescript
public setAuthority(pubkey: string, type: string = "rsa"): void
```

Set the signing authority of who can sign on behalf of this Activity Stream to issue a valid transaction. Currently you have to provide the public key in PEM format and the cryptographic function for this key. This could be an unknown but if you want to assign them from an existing Activity the current shortcut is :

```typescript
newActivityStream().setAuthority(
    getActivityStreams([stream]).getAuthority(),
    getActivityStreams([stream]).getAuthority(true)
);
```

---

```typescript
public setContractLock(script: string | Array<string>): boolean
```

As the contract is the creator of a new stream it has a single chance to lock the stream to a specific contract or a list of contracts.

```typescript
public setNamespaceLock(namespace: string | Array<string>): boolean
```

As the contract is the creator of a new stream it has a single chance to lock the stream to a specific collections of namespaces instead of specific collection of contracts as above.

```typescript
public getId(): string 
public getName(): string
```

Get the activity stream id

```typescript
public getState(): ActiveDefinitions.IState
```

Get the data of the activity

```typescript
public setState(state: ActiveDefinitions.IState): void
```

Set the data of the activity

```typescript
public getVolatile(): ActiveDefinitions.IVolatile
```

This gets the volatile data of the activity

```typescript
public setVolatile(volatile: ActiveDefinitions.IVolatile): void
```

This sets the volatile data of the activity

**Volatile data is "off-chain like data" that is still stored within Activeledger. It is volatile because if lost it cannot be recovered from other nodes. Use with caution!**

```typescript
public getCng(buffer?: string): number
```

CNG stands for "Consensus Number Generator" this is not a RNG replacement however it can be used if all you require is a predictable but unknown number to act like a random number for calculations. This function will return the same value across all nodes but that value will be unique to that contract and this activity which is why it provides the feeling of a random number. The buffer is a string you can add to prevent other contracts getting similar values.

##### Access Control Layer

There are some basic functions to handle ACL for the activities. Activeledger currently doesn't do much with these ACL values apart from keeping them outside the data state object. It is up the the contract developer to manage these.

```typescript
public setACL(name: string, stream: string)
```

Create a access role name and the activity stream id who has that role.

```typescript
public hasACL(name: string): boolean
```

Does this activity have an ACL role set

#### Multiple Entry Points

You can expand on a single contract file to manage multiple actions. The transaction message has a property called $entry. This can be picked up within your contract and a switch statement can run the specific logic.

```typescript
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "add":
          // add funds logic
          break;
        default:
          // transfer funds logic
          break;
      }
    });
  }
```

