rm -rf ./stagetmp
mkdir ./stagetmp

# contracts
mkdir ./stagetmp/activecontracts
cp -r ./packages/contracts/es/ ./stagetmp/activecontracts
cp -r ./packages/contracts/lib/ ./stagetmp/activecontracts
cp -r ./packages/contracts/package.json ./stagetmp/activecontracts

# network
mkdir ./stagetmp/activenetwork
cp -r ./packages/network/es/ ./stagetmp/activenetwork
cp -r ./packages/network/lib/ ./stagetmp/activenetwork
cp -r ./packages/network/package.json ./stagetmp/activenetwork

# protocol
mkdir ./stagetmp/activeprotocol
cp -r ./packages/protocol/es/ ./stagetmp/activeprotocol
cp -r ./packages/protocol/lib/ ./stagetmp/activeprotocol
cp -r ./packages/protocol/package.json ./stagetmp/activeprotocol

# utilities
mkdir ./stagetmp/activeutilities
cp -r ./packages/utilities/es/ ./stagetmp/activeutilities
cp -r ./packages/utilities/lib/ ./stagetmp/activeutilities
cp -r ./packages/utilities/package.json ./stagetmp/activeutilities

tar -czf stagedeploy.tar.gz ./stagetmp

scp stagedeploy.tar.gz adam@ant-stage-1:/home/adam
scp stagedeploy.tar.gz adam@ant-stage-2:/home/adam
scp stagedeploy.tar.gz adam@ant-stage-3:/home/adam
scp stagedeploy.tar.gz adam@ant-stage-4:/home/adam
scp stagedeploy.tar.gz adam@ant-stage-5:/home/adam
scp stagedeploy.tar.gz adam@ant-stage-6:/home/adam

#tar -xvf stagedeploy.tar.gz
#cp -r ./stagetmp/ /home/adam/.nvm/versions/node/v20.12.2/lib/node_modules/@activeledger/activeledger/node_modules/@activeledger
#rm -rf ./stagetmp

rm -rf ./stagetmp
rm stagedeploy.tar.gz

#/home/adam/.nvm/versions/node/v20.12.2/lib/node_modules/@activeledger/activeledger
#npm i undici