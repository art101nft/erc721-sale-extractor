const { BigNumber, ethers } = require('ethers');
const fs = require('fs');
const { Database } = require('sqlite3');


if (fs.existsSync('.env.local')) {
  require('dotenv').config({path: '.env.local'});
} else {
  console.warn('[!] No .env.local found, quitting.');
  process.exit();
}

const CHUNK_SIZE = Number(process.env.CHUNK_SIZE);
const ALL_CONTRACTS = require('../data/contracts');
const ERC721_ABI = require('../data/erc721');
const ERC1155_ABI = require('../data/erc1155');
const MARKETPLACE_ABI = require('../data/marketplace');
const SEAPORT_ABI = require('../data/seaport');
const LOOKSRARE_ABI = require('../data/looksrare');
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LOOKSRARE_SALE_TOPIC = '0x95fb6205e23ff6bda16a2d1dba56b9ad7c783f67c96fa149785052f47696f2be';
const SEAPORT_SALE_TOPIC = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
const X2Y2_SALE_TOPIC = '0x3cbb63f144840e5b1b0a38a7c19211d2e89de4d7c5faf8b2d3c1776c302d1d33';
const seaportInterface = new ethers.utils.Interface(SEAPORT_ABI);
const looksrareInterface = new ethers.utils.Interface(LOOKSRARE_ABI);
const provider = new ethers.providers.WebSocketProvider(process.env.GETH_NODE);
const db = new Database('./storage/sqlite.db');


class Collection {
  constructor (contractName) {
    if (!(contractName in ALL_CONTRACTS)) {
      console.warn(`[!] That contract name does not exist in data/contracts.json`);
      process.exit();
    }
    const data = ALL_CONTRACTS[contractName];
    this.contractName = contractName;
    this.contractAddress = data['contract_address'].toLowerCase();
    this.erc1155 = data['erc1155'];
    this.startBlock = data['start_block'];
    if (this.erc1155) {
      this.abi = ERC1155_ABI;
    } else {
      this.abi = ERC721_ABI;
    }
  }
}

class Scrape extends Collection {

  provider = this.getWeb3Provider();

  constructor (contractName) {
    super(contractName)
    this.contract = new ethers.Contract(this.contractAddress, this.abi, this.provider);
    this.lastFile = `./storage/lastBlock.${this.contractName}.txt`;
  }

  // ethereum chain provider - geth, infura, alchemy, etc
  getWeb3Provider() {
    return provider;
  }

  // continuous scanning loop
  async scrape() {
    let latestEthBlock = await this.provider.getBlockNumber();
    let lastScrapedBlock = this.getLastBlock();
    while (lastScrapedBlock < latestEthBlock) {
      const lastRequested = lastScrapedBlock;

      await this.filterTransfers(lastScrapedBlock).then((ev) => {
        ev.map(tx => tx.transactionHash).filter((tx, i, a) => a.indexOf(tx) === i).map(async txHash => {
          await this.getSalesEvents(txHash);
        });
      })

      if (lastRequested === lastScrapedBlock) {
        lastScrapedBlock += CHUNK_SIZE;
        this.writeLastBlock(lastScrapedBlock);
        if (lastScrapedBlock > latestEthBlock) lastScrapedBlock = latestEthBlock;
      }

      while (lastScrapedBlock >= latestEthBlock) {
        latestEthBlock = await this.provider.getBlockNumber();
        console.log(`${this.contractName} - waiting for new blocks. last: ${lastScrapedBlock}`)
        await this.sleep(30);
      }
    }
  }

  // query historical logs
  async filterTransfers(startBlock) {
    console.log(`${this.contractName} - scraping blocks ${startBlock} - ${startBlock + CHUNK_SIZE}`);
    const transfers = this.contract.filters.Transfer(null, null);
    let res = await this.contract.queryFilter(transfers, startBlock, startBlock + CHUNK_SIZE)
    return res;
  }

  // get sales events from a given transaction
  async getSalesEvents(txHash) {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      const block = await this.provider.getBlock(receipt.blockNumber);
      const timestamp = new Date(block.timestamp * 1000);
      // Evaluate each log entry and determine if it's a sale for our contract and use custom logic for each exchange to parse values
      receipt.logs.map((log) => {
        let logIndex = log.logIndex;
        let platform = 'contract';
        let sale = false;
        let fromAddress;
        let toAddress;
        let amountWei;
        let amountEther;
        let tokenId;
        if (log.topics[0].toLowerCase() === SEAPORT_SALE_TOPIC.toLowerCase()) {
          // Handle Opensea/Seaport sales
          const logDescription = seaportInterface.parseLog(log)
          const matchingOffers = logDescription.args.offer.filter(
            o =>  o.token.toLowerCase() == this.contractAddress
          );
          if (matchingOffers.length === 0) return;
          sale = true;
          platform = 'opensea';
          fromAddress = logDescription.args.offerer.toLowerCase();
          toAddress = logDescription.args.recipient.toLowerCase();
          tokenId = logDescription.args.offer.map(o => o.identifier.toString());
          let amounts = logDescription.args.consideration.map(c => BigInt(c.amount));
          // add weth
          const wethOffers = matchingOffers.map(o => o.token.toLowerCase() === WETH_ADDRESS.toLowerCase() && o.amount > 0 ? BigInt(o.amount) : BigInt(0));
          if (wethOffers.length > 0 && wethOffers[0] != BigInt(0)) {
            amounts = wethOffers
          }
          amountWei = amounts.reduce((previous,current) => previous + current, BigInt(0));
        } else if (log.topics[0].toLowerCase() === LOOKSRARE_SALE_TOPIC.toLowerCase()) {
          // Handle LooksRare sales
          const logDescription = looksrareInterface.parseLog(log);
          if (logDescription.args.collection.toLowerCase() != this.contractAddress) return;
          sale = true;
          platform = 'looksrare';
          fromAddress = logDescription.args.maker.toLowerCase();
          toAddress = receipt.from.toLowerCase();
          tokenId = logDescription.args.tokenId.toString();
          amountWei = logDescription.args.price.toString();
        } else if (log.topics[0].toLowerCase() === X2Y2_SALE_TOPIC.toLowerCase()) {
          // Handle x2y2 sales
          const data = log.data.substring(2);
          const dataSlices = data.match(/.{1,64}/g);
          sale = true;
          platform = 'x2y2';
          fromAddress = BigNumber.from(`0x${dataSlices[0]}`)._hex.toString().toLowerCase();
          toAddress = BigNumber.from(`0x${dataSlices[1]}`)._hex.toString().toLowerCase();
          tokenId = BigInt(`0x${dataSlices[18]}`).toString();
          amountWei = BigInt(`0x${dataSlices[12]}`);
          if (amountWei === BigInt(0)) {
            amountWei = BigInt(`0x${dataSlices[26]}`);
          }
        }
        if (sale) {
          this.writeLastBlock(log.blockNumber);
          amountEther = ethers.utils.formatEther(amountWei);
          let msg = `${this.contractName} - found sale of token ${tokenId} for ${amountEther}Ξ on ${platform}. ${txHash} - ${timestamp.toISOString()}`;
          console.log(msg);
        }
      });
    } catch(err) {
      console.log(err);
    }
  }

  // more readable wallet address
  shortenAddress(address) {
    const shortAddress = `${address.slice(0, 5)}...${address.slice(address.length - 4, address.length)}`;
    if (address.startsWith('0x')) return shortAddress;
    return address;
  }

  /* Database */

  // create the db if needed

  // check if db row exists

  // write event to db

  /* Helpers */

  // get stored block index to start scraping from
  getLastBlock() {
    let last = 0;
    if (fs.existsSync(this.lastFile)) {
      // read block stored in lastBlock file
      last = parseInt(fs.readFileSync(this.lastFile).toString(), 10);
    } else {
      // write starting block if lastBlock file doesn't exist
      fs.writeFileSync(this.lastFile, this.startBlock.toString());
    };
    // contract creation
    if (Number.isNaN(last) || last < this.startBlock) {
      last = this.startBlock;
    };
    return last;
  }

  writeLastBlock(blockNumber) {
    fs.writeFileSync(this.lastFile, blockNumber.toString());
  }

  // sleep
  async sleep(sec) {
    return new Promise((resolve) => setTimeout(resolve, Number(sec) * 1000));
  }
}

let c = new Scrape('rmutt')
c.scrape()
// Sample events for testing functionality and detecting sales
// c.getSalesEvents('0x2f8961209daca23288c499449aa936b54eec5c25720b9d7499a8ee5bde7fcdc7')
// c.getSalesEvents('0xb20853f22b367ee139fd800206bf1cba0c36f1a1dd739630f99cc6ffd0471edc')
// c.getSalesEvents('0x71e5135a543e17cc91992a2229ae5811461c96b84d5e2560ac8db1dd99bb17e3')
// c.getSalesEvents('0x5dc68e0bd60fa671e7b6702002e4ce374de6a5dd49fcda00fdb45e26771bcbd9')
