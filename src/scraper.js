const { BigNumber, ethers } = require('ethers');
const fs = require('fs');
const { Database } = require('sqlite3');
const { postDiscord } = require('./poster');


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
    await createDatabaseIfNeeded();
    let latestEthBlock = await this.provider.getBlockNumber();
    let lastScrapedBlock = this.getLastBlock();
    while (true) {
      const lastRequested = lastScrapedBlock;

      await this.filterTransfers(lastScrapedBlock).then(async ev => {
        // capture transfer events with returned array of Transfers
        await this.getTransferEvents(ev);
        // filter down unique transaction hashes
        ev.map(tx => tx.transactionHash).filter((tx, i, a) => a.indexOf(tx) === i).map(async txHash => {
          // capture sales events for each
          await this.getSalesEvents(txHash);
        });
      });

      if (lastRequested === lastScrapedBlock) {
        lastScrapedBlock += CHUNK_SIZE;
        this.writeLastBlock(lastScrapedBlock);
        if (lastScrapedBlock > latestEthBlock) lastScrapedBlock = latestEthBlock;
      }

      while (lastScrapedBlock >= latestEthBlock) {
        latestEthBlock = await this.provider.getBlockNumber();
        console.log(`${this.contractName} - waiting for new blocks. last: ${lastScrapedBlock}`)
        await sleep(300);
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

  // get transfer events from a batch from filtering
  async getTransferEvents(txEvents) {
    let platform = 'contract';
    txEvents.forEach(async tx => {
      const fromAddress = tx.args.from.toString().toLowerCase();
      const toAddress = tx.args.to.toString().toLowerCase();
      const tokenId = tx.args.tokenId.toString();
      const timestamp = await this.getBlockTimestamp(tx.blockNumber);
      this.writeLastBlock(tx.blockNumber);
      let msg = `${this.contractName} - found transfer of token ${tokenId}. ${tx.transactionHash} - ${timestamp.toISOString()}`;
      console.log(msg);
      const q = {
        txHash: tx.transactionHash,
        logIndex: tx.logIndex,
        contractName: this.contractName,
        contractAddress: this.contractAddress,
        eventName: "transfer",
        eventSource: "contract",
        sourceOwner: fromAddress,
        targetOwner: toAddress,
        tokenId: tokenId,
        amount: 0,
        txDate: timestamp
      }
      await writeToDatabase(q);
    });
  }

  // get sales events from a given transaction
  async getSalesEvents(txHash) {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      const timestamp = await this.getBlockTimestamp(receipt.blockNumber);
      // Evaluate each log entry and determine if it's a sale for our contract and use custom logic for each exchange to parse values
      receipt.logs.map(async log => {
        let logIndex = log.logIndex;
        let sale = false;
        let platform;
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
          amountEther = ethers.utils.formatEther(amountWei);
          let msg = `${this.contractName} - found sale of token ${tokenId} for ${amountEther}Ξ on ${platform}. ${txHash} - ${timestamp.toISOString()}`;
          console.log(msg);
          const q = {
            txHash: txHash,
            logIndex: logIndex,
            contractName: this.contractName,
            contractAddress: this.contractAddress,
            eventName: "sale",
            eventSource: platform,
            sourceOwner: fromAddress,
            targetOwner: toAddress,
            tokenId: tokenId,
            amount: amountWei,
            txDate: timestamp
          }
          await writeToDatabase(q);
          await postDiscord(q);
        }
      });
    } catch(err) {
      console.log(err);
    }
  }

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

  // write last block to local filesystem
  writeLastBlock(blockNumber) {
    fs.writeFileSync(this.lastFile, blockNumber.toString());
  }

  // return date object of a given block
  async getBlockTimestamp(blockNumber) {
    const block = await this.provider.getBlock(blockNumber);
    const d = new Date(block.timestamp * 1000);
    return d;
  }

}

async function sleep(sec) {
  return new Promise((resolve) => setTimeout(resolve, Number(sec) * 1000));
}

async function createDatabaseIfNeeded() {
  const tableExists = await new Promise((resolve) => {
    db.get('SELECT name FROM sqlite_master WHERE type="table" AND name="events"', [], (err, row) => {
      if (err) {
        resolve(false);
      }
      resolve(row !== undefined);
    });
  });
  if (!tableExists) {
    db.serialize(() => {
      console.log('[+] creating table');
      db.run(
        `CREATE TABLE events (
          contract text, event_type text, from_wallet text, to_wallet text,
          token_id number, amount number, tx_date text, tx text,
          log_index number, platform text,
          UNIQUE(tx, log_index)
        );`,
      );
      console.log('[+] creating indexes');
      db.run('CREATE INDEX idx_type_date ON events(event_type, tx_date);');
      db.run('CREATE INDEX idx_date ON events(tx_date);');
      db.run('CREATE INDEX idx_amount ON events(amount);');
      db.run('CREATE INDEX idx_platform ON events(platform);');
      db.run('CREATE INDEX idx_contract ON events(contract);');
      db.run('CREATE INDEX idx_tx ON events(tx);');
    });
    console.log('[+] database created');
  }
}

async function checkRowExists(txHash, logIndex) {
  const rowExists = await new Promise((resolve) => {
    db.get('SELECT * FROM events WHERE tx = ? AND log_index = ?', [txHash, logIndex], (err, row) => {
      if (err) {
        resolve(false);
      }
      resolve(row !== undefined);
    });
  });
  return rowExists;
}

async function writeToDatabase(_q) {
  // txHash, logIndex, contractName, contractAddress, eventName, eventSource, sourceOwner, targetOwner, tokenId, amount, txDate
  const rowExists = await checkRowExists(_q.txHash, _q.logIndex, _q.contractAddress);
  if (!rowExists) {
    let stmt;
    try {
      stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
      stmt.run(
        _q.contractAddress,
        _q.eventName,
        _q.sourceOwner,
        _q.targetOwner,
        _q.tokenId,
        _q.amount.toString(),
        _q.txDate.toISOString(),
        _q.txHash,
        _q.logIndex,
        _q.eventSource
      );
      stmt.finalize();
    } catch(err) {
      console.log(`Error when writing to database: ${err}`);
      console.log(`Query: ${stmt}`)
    }
  }
}


let c = new Scrape('rmutt')
// c.scrape()

// Sample events for testing functionality and detecting sales
// c.getSalesEvents('0x2f8961209daca23288c499449aa936b54eec5c25720b9d7499a8ee5bde7fcdc7')
// c.getSalesEvents('0xb20853f22b367ee139fd800206bf1cba0c36f1a1dd739630f99cc6ffd0471edc')
// c.getSalesEvents('0x71e5135a543e17cc91992a2229ae5811461c96b84d5e2560ac8db1dd99bb17e3')
// c.getSalesEvents('0x5dc68e0bd60fa671e7b6702002e4ce374de6a5dd49fcda00fdb45e26771bcbd9')
// c.getSalesEvents('0x975d10cdd873ee5bb29e746c2f1f3b776078cace9c04ce419cb66949239288b5')
c.getSalesEvents('0x8d45ed8168a740f8b182ec0dbad1c37d6c6dbd8aa865be408d865ca01fb0fa94')
