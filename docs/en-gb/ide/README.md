# Activeledger IDE (Active Harmony) User Guide

In this guide we will explain how to setup the IDE so you can begin publishing smart contracts right away. As you can see in the image below the IDE will take care of everything for you, allowing you to concentrate on your smart contract logic.

![Activeledger IDE](https://activeledger.io/wp-content/uploads/2018/10/developer-tools-demo.gif)

## Tx Section

### 1. Connection Setup

The first step is to configure the Activeledger node connections. On the top right you will see a spanner icon. Click this to load the General settings screen.

![General Settings](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-50-00.png)

Under the _Connections_ section add the location of your Activeledger node. If you're running a local testnet you can use the following settings:

- Name : Local Testnet
- Protocol : http
- Address : localhost
- Port : 5260

Encrypted Transactions is not a requirement. However, if you are submitting transactions across an untrusted network this will hide the transaction data.

In this section you will find other options. The most important one is the backup and restore functionaility. The backup function allows you to generate a single file that exports all the information within the IDE. It has a password protection function, as this backup can include your private keys.

### 2. Key Generation

As smart contracts are stored on the ledger itself you need to have an identity registered on each network you will be publishing contracts to.

On the left hand side select _Keys_, you will be taken to a screen which lists all the keys managed in the IDE. You will find a tab labeled _Generate_. Here you can create a new key and onboard it to a previously entered connection. (You don't have to onboard a key right away)

![Key Management](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-50-32.png)

### 3. Namespaces

[Namespaces](../contracts/deployment/namespace.md) are designed to prevent collisions. Contracts are stored inside a namespace as an Activeledger asset and they are referenced by unique stream IDs. They also allow additional libraries to be imported into the smart contract VM.

To register a namespace, on the left hand side select _Namespaces_ and you will be taken to a screen which lists all the registered namespaces. You will find a tab labeled _Create_. Select this tab and you can create a namespace for a specific key. Currently Activeledger only supports a single namespace per key. However, you can maintain as many keys as you need.

Select your key and enter a name for your namespace. After clicking save, the IDE will create a transaction request to the network the key is registered to and attempt to reserve your namespace if it hasn't already been taken.

![Namespace Management](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-51-39.png)

### 4. Writing Smart Contracts

Now the IDE is ready to publish your [smart contracts](../contracts/README.md). You can create a new smart contract from anywhere within the IDE by clicking the quick action button on the top left (the + icon). This will load up a code editor with built in auto completion. You can learn more about the basics of [writing a smart contract here](../contracts/standard.md).

![Composing Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-52-43.png)

Clicking the save icon at the top of the editor will allow you to set the name and version of this smart contract. Remember, Activeledger supports multiple versions of contract code so you can continue to revise and update the contract but still run transactions against previous versions.

![Version Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-06.png)

### 5. Uploading Smart Contracts

Once you have written and saved your smart contract you need to publish it to an Activeledger network. On the same screen you will see a tab labeled _Upload_. Select this tab to open the upload manager. On the left hand side you will see all the smart contracts the IDE is managing. When you select the smart contract you wish to upload it will default to the latest version. If you wish to upload a different version there is a small arrow on the right hand side above the minimap. This will open a dropdown menu allowing you to change versions and manage other settings.

When you have selected your contract you need to choose the network you would like to upload to. Below the editor you will be able to select the key, namespace, and connection you would like to use. Clicking _upload_ will generate a new transaction with your smart contract as the payload.

![Upload Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-25.png)

### 6. Managing Smart Contracts

On the same screen you will see a tab labeled _Editor_ this will list all the smart contracts the IDE is aware of, both local only and published. If the smart contract has been publish you can access its stream ID via 2 methods.
Activeledger also supports contract labeling to make it easier to run smart contracts. This is can be done by going to the contract information. In the Editor tab click "Show" under "Info" or in an open contract, select the kebab icon in the top right and click "Show info".

![Manage Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-45.png)

- The first "Stream ID" will show a dialog listing all the networks the smart contract has been uploaded to and the corresponding stream id.

- The second "Info" will change the page and provide further information about the smart contract status. From this screen you can also add reference labels for a smart contract so you can run the contract using the label name instead of having to remember the longer stream id. Referenced contract names allow you to reuse a transaction across multiple networks but run different contracts.

![Manage Smart Contracts Detail](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-51.png)

## BaaS

To switch to the BaaS section of Harmony click the Tx BaaS Button found in the top right of the app.

### Dashboard

The dashboard shows statistics of a selected node. This includes a graph of the host CPU usage, as well as host usage of CPU, RAM, and HDD in the form of a percentage bar, and the Activeledger statistics of the given node including: Version, Uptime, Activeledger specific disk usage, auto, manual and total restarts and when the last manual restart occurred.

Clicking a node in the list will load these statistics if a connection can be made to the host. Clicking the view button in the nodes list will open that node in the nodes page.

### Network

The network page displays a list of the network configurations that have been created or imported. It also provides a link to the Network Builder via the New Config button. Configurations can also be imported directly using the Import Config button.

#### Network list

The network list displays a list of configurations.

You can click the view button to open the config in the network builder.

Clicking on a config will display further options in the control panel on the right side of the page. These include: Duplicate, Edit, Remove, Onboard, and Export Config.

##### Duplicate

Duplicate will simply duplicate a given config and append "(x)" to the end of the name, where x is the number of duplicates starting from 2. You can use the Edit option to change the name.

##### Edit

Edit opens the selected configuration in the network builder allowing you to modify it.

##### Remove

This will delete the selected configuration. 

##### Onboard

Onboard will toggle the onboarded status of the configuration. Currently this is only used as a flag for ease of use.

##### Export Config

This option will allow you to save the selected config as a JSON file on your system.

#### Timeline

The timeline displays a list of the latest actions performed on configs.

### Network Builder

The network builder allows you to quickly generate a new network configuration, for further information on the available settings see the Activeledger [configuration documentation](https://github.com/activeledger/activeledger/blob/master/docs/en-gb/configuration.md)

The general options can be set under the General tab, whilst Nodes are added under the Nodes tab. Multiple nodes can be added to the configuration.

The configuration can be saved, which will store it in Harmony, exported for use in a network and cleared to reset all the options.

Once saved, the configuration will be listed in the Network page.

### Nodes

This page allows you to control the nodes in a network. You can connect to an existing Activeledger node, add a new Activeledger node (where a host already exists), and manage previously added nodes.

#### Add

To get started you must first create a connection to a host, this is done via SSH.

The required data is as follows:

* Name - The name of the node, this is only used in Harmony.
* Address - The IP address of the host
* Port - The port on the host used for SSH connections
* Node location - The location in which Activeledger is installed or will be installed. **Example:** /home/{user}/activeledger
* Username - The username used to connect to the host
* Password - The password used to connect to the host, this is not stored in Harmony. If using an SSH key this will be used to create an identity if needed on first connection.
* Connection 
  * Generate SSH Key - Generate a key pair and upload the public key to the server
  * Use Password - Connect to the server using password instead of key **Note:** This requires you to input the password on every connection to the server.
  * Onboard SSH Key - Onboard and use a pre-generated SSH key



#### General

Once a node has been added you can select it to login to the host and show additional functionality in the control panel and info panel to the right of the page.

In the node list, every node has a refresh and a logs option. Refresh will refresh the data displayed for that node. Logs will open a logs page that displays the Activeledger output streamed from the server. **Note:** The logs page only shows log data from the time you open the logs page as it is streamed directly from Activeledger rather than from a log file to negate the impact of extra I/O.

##### Control Panel

Selecting a node will display the following extra functionality in the control panel:

* Edit - Edit the connection details for a node
* Remove - Remove the selected node
* Connect/Disconnect - If not connected "Connect" will show, if connected "Disconnect" will show
  * Connect - Attempt to connect to the node if a connection was not automatically established
  * Disconnect - Terminate the SSH connection to the node
* Restart - Only displayed if a running instance of Activeledger is found, used to restart the Activeledger instance
* Start/Stop - If Activeledger found and not running "Start" displayed, if running "Stop" displayed
  * Start - Start the Activeledger instance
  * Stop - Stop the Activeledger instance
* Install - If an instance of Activeledger is not found in the given location this option is displayed; clicking it will attempt to install Activeledger in that location.
* Update - This option is displayed if the running version of Activeledger is less than the latest released version
* Rollback - Rollback to a previous version of Activeledger if found
* Manage Node Tags - Allows tags to be added and removed from the node - Used to filter added nodes in Harmony.

##### Info Panel

The info panel displays statistics of the connected Node and its Host.

* Status - The connection status of the selected nodes host; Online if SSH connection established, Offline if not
* Resources - The usage of CPU, RAM, and HDD resources of the host, and Activeledger Disk usage
* Version - The running version of Activeledger and the latest released version
* Uptime - How long the Activeledger instance has been running
* Restarts
  * Auto - The amount of automatic restarts
  * Manual - The amount of manual restarts
  * Total restarts - The amount of both automatic and manual restarts
  * Last Manual - The last time the node was manually restarted

#### Manage all tags

This opens a dialog box allowing you to add and remove tags which can be linked to nodes in order to filter them.

