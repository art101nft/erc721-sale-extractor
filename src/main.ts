#!/usr/bin/env ts-node
/* eslint-disable no-shadow */
/* eslint-disable no-loop-func */
/* eslint-disable prefer-destructuring */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-use-before-define */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */

import Web3 from 'web3';
import BN from 'bignumber.js';
import { promisify } from 'util';
import fs from 'fs';
import { Database } from 'sqlite3';
import dotenv from 'dotenv';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

// Use this if you wanna force recreation the initial database
const REGENERATE_FROM_SCRATCH = false;
const CHUNK_SIZE = 800; // lower this if geth node is hanging
const web3 = new Web3(getWeb3Provider());
const RARIBLE_TOPIC0 = '0xcae9d16f553e92058883de29cb3135dbc0c1e31fd7eace79fef1d80577fe482e';
const OPENSEA_SALE_TOPIC0 = '0xc4109843e0b7d514e4c093114b863f8e7d8d9a458c372cd51bfe526b588006c9';
const LOOKSRARE_SALE_TOPIC0 = '0x95fb6205e23ff6bda16a2d1dba56b9ad7c783f67c96fa149785052f47696f2be';
const X2Y2_SALE_TOPIC0 = '0xe2c49856b032c255ae7e325d18109bc4e22a2804e2e49a017ec0f59f19cd447b';

const readFile = promisify(fs.readFile);
console.log(`opening database at ${process.env.WORK_DIRECTORY + process.env.DATABASE_FILE}`);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);

async function work(contractName: string, contractAddress:string, isERC1155:boolean, startBlock:number) {
  console.log(`Starting work for ${contractName} (is ERC1155: ${isERC1155})`);
  let abi;
  let eventName;
  const lastFile = `${process.env.WORK_DIRECTORY}${contractAddress}.last.txt`;
  if (REGENERATE_FROM_SCRATCH) {
    console.log(`Regenerating ${lastFile} from beginning`);
    fs.unlinkSync(lastFile);
  }
  if (isERC1155) {
    abi = await readFile(process.env.ERC1155_ABI);
    eventName = 'TransferSingle';
    console.log(`Using ERC-1155 ABI for ${contractName} - searching for ${eventName} events.`);
  } else {
    abi = await readFile(process.env.ERC721_ABI);
    eventName = 'Transfer';
    console.log(`Using ERC-721 ABI for ${contractName} - searching for ${eventName} events.`);
  }
  let last = retrieveCurrentBlockIndex(contractAddress, startBlock);
  const json = JSON.parse(abi.toString());
  const contract = new web3.eth.Contract(
    json,
    contractAddress,
  );
  console.log(`${contractName} - starting from block: ${last}`);
  let latest = await web3.eth.getBlockNumber();
  while (last < latest) {
    try {
      const block = await web3.eth.getBlock(last);
      const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
      fs.writeFileSync(lastFile, last.toString());
      const lastRequested = last;
      const events = await contract.getPastEvents(eventName, {
        fromBlock: last,
        toBlock: last + CHUNK_SIZE, // handle blocks by chunks
      });
      if (events.length == 0) continue;
      console.log(`\n${contractName} - handling ${events.length} events from blocks ${last}-${last + CHUNK_SIZE} [${blockDate.toISOString()}]`);
      for (const ev of events) {
        last = ev.blockNumber;
        // Skip tx logs if already exists in DB
        const rowExists = await checkRowExists(ev.transactionHash, ev.logIndex, contractAddress);
        if (rowExists) {
          process.stdout.write('.');
          continue
        };
        const tr = await web3.eth.getTransactionReceipt(ev.transactionHash);
        let saleFound = false;
        const txBlock = await web3.eth.getBlock(tr.blockNumber);
        const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
        for (const l of tr.logs) {
          // start log loop, checking for known topics
          if (l.topics[0] === RARIBLE_TOPIC0
            || l.topics[0] === OPENSEA_SALE_TOPIC0
            || l.topics[0] === LOOKSRARE_SALE_TOPIC0
            || l.topics[0] === X2Y2_SALE_TOPIC0) {
            saleFound = true;
          }
          if (l.topics[0] === OPENSEA_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            await writeToDatabase(ev.transactionHash, ev.logIndex, contractName, contractAddress, 'sale', 'opensea', ev.returnValues.from.toLowerCase(), ev.returnValues.to.toLowerCase(), ev.returnValues.tokenId, parseInt(dataSlices[2], 16), txDate);
          } else if (l.topics[0] === X2Y2_SALE_TOPIC0) {
            const data = l.data.substring(2)
            const dataSlices = data.match(/.{1,64}/g);
            await writeToDatabase(ev.transactionHash, ev.logIndex, contractName, contractAddress, 'sale', 'x2y2', ev.returnValues.from.toLowerCase(), ev.returnValues.to.toLowerCase(), ev.returnValues.tokenId, parseInt(dataSlices[3], 16), txDate);
          } else if (l.topics[0] === LOOKSRARE_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            await writeToDatabase(ev.transactionHash, ev.logIndex, contractName, contractAddress, 'sale', 'looksrare', ev.returnValues.from.toLowerCase(), ev.returnValues.to.toLowerCase(), ev.returnValues.tokenId, parseInt(dataSlices[6], 16), txDate);
          } else if (l.topics[0] === RARIBLE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            if (dataSlices.length < 12) {
              continue;
            }
            const amount = tr.logs.filter((t) => {
              if (t.topics[0] === RARIBLE_TOPIC0) {
                const nftData = t.data.substring(2);
                const nftDataSlices = nftData.match(/.{1,64}/g);
                return nftDataSlices.length === 10 || nftDataSlices.length === 11;
              }
              return false;
            }).map((log) => {
              const nftData = log.data.substring(2);
              const nftDataSlices = nftData.match(/.{1,64}/g);
              const re = parseInt(nftDataSlices[6], 16);
              return re;
            }).reduce((previousValue, currentValue) => previousValue + currentValue, 0);
            await writeToDatabase(ev.transactionHash, ev.logIndex, contractName, contractAddress, 'sale', 'rarible', ev.returnValues.from.toLowerCase(), ev.returnValues.to.toLowerCase(), ev.returnValues.tokenId, amount, txDate);
          }
          // any other logic during log loop
        }

        if (!saleFound) {
          // no sale found, index a mint/transfer event
          let eventName;
          if (ev.returnValues.from.toLowerCase() == '0x0000000000000000000000000000000000000000') {
            eventName = 'mint';
          } else {
            eventName = 'transfer';
          }
          await writeToDatabase(ev.transactionHash, ev.logIndex, contractName, contractAddress, eventName, 'contract', ev.returnValues.from.toLowerCase(), ev.returnValues.to.toLowerCase(), ev.returnValues.tokenId, 0, txDate);
        }
      } // end events loop
      const initialLast = last; // checking purpose

      // prevent an infinite loop on an empty set of block
      if (lastRequested === last) {
        last += CHUNK_SIZE;
        if (last > latest) last = latest;
      }

      while (last >= latest) {
        latest = await web3.eth.getBlockNumber();
        console.log('\n', contractName, ' - waiting for new blocks, last:', last, ', latest:', latest, '...');
          // wait for new blocks (300 seconds)
          await sleep(300000);
      }
    } catch (err) {
      console.log('error received, will try to continue', err);
    }
  }
  console.log('\nended. should tail now');
}

function retrieveCurrentBlockIndex(contractAddress:string, startBlock:number):number {
  let last:number = 0;
  const lastFile = `${process.env.WORK_DIRECTORY}${contractAddress}.last.txt`;
  if (fs.existsSync(lastFile)) {
    last = parseInt(fs.readFileSync(lastFile).toString(), 10);
  } else {
    fs.writeFileSync(lastFile, startBlock);
  };
  // contract creation
  if (Number.isNaN(last) || last < startBlock) {
    last = startBlock
  };
  console.log(`\nFound last block ${last} for ${contractAddress}`)
  return last;
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
  if (REGENERATE_FROM_SCRATCH || !tableExists) {
    console.log('Recreating database...');
    if (fs.existsSync(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE)) fs.unlinkSync(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);
    db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);
    db.serialize(() => {
      console.log('create table');
      db.run(
        `CREATE TABLE events (
          contract text, event_type text, from_wallet text, to_wallet text,
          token_id number, amount number, tx_date text, tx text,
          log_index number, platform text,
          UNIQUE(tx, log_index)
        );`,
      );
      console.log('create indexes');
      db.run('CREATE INDEX idx_type_date ON events(event_type, tx_date);');
      db.run('CREATE INDEX idx_date ON events(tx_date);');
      db.run('CREATE INDEX idx_amount ON events(amount);');
      db.run('CREATE INDEX idx_platform ON events(platform);');
      db.run('CREATE INDEX idx_contract ON events(contract);');
      db.run('CREATE INDEX idx_tx ON events(tx);');
    });
    console.log('Database created...');
  }
}

async function sleep(msec:number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, msec));
}

function getWeb3Provider() {
  console.log(`Connecting to web3 provider: ${process.env.GETH_NODE_ENDPOINT}`);
  const provider = new Web3.providers.WebsocketProvider(
    process.env.GETH_NODE_ENDPOINT,
    {
      clientConfig: {
        keepalive: true,
        keepaliveInterval: 8000,
        maxReceivedFrameSize: 3000000, // bytes - default: 1MiB, current: 3MiB
        maxReceivedMessageSize: 20000000, // bytes - default: 8MiB, current: 20Mib
      },
      reconnect: {
        auto: true,
        delay: 8000, // ms
        maxAttempts: 15,
        onTimeout: true,
      },
    },
  );
  return provider;
}

async function checkRowExists(txHash:string, logIndex:number, contractAddress:string) {
  const rowExists = await new Promise((resolve) => {
    db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [txHash, logIndex, contractAddress], (err, row) => {
      if (err) {
        resolve(false);
      }
      resolve(row !== undefined);
    });
  });
  return rowExists;
}

async function writeToDatabase(txHash:string, logIndex:number, contractName:string, contractAddress:string, eventName:string, eventSource:string, sourceOwner:string, targetOwner:string, tokenId:string, amount:number, txDate:Date) {
  const rowExists = await checkRowExists(txHash, logIndex, contractAddress);
  if (!rowExists) {
    let stmt;
    try {
      stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
      stmt.run(contractAddress, eventName, sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), txHash, logIndex, eventSource);
      stmt.finalize();
      process.stdout.write('+');
    } catch(err) {
      console.log(`Error when writing to database: ${err}`);
      console.log(`Query: ${stmt}`)
    }

  } else {
    process.stdout.write('.');
  }
  debugPrint(`\n${contractName} - ${txDate.toLocaleString()} - indexed event '${eventName}' from '${eventSource}' for token ${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${txHash}.`);
}

function debugPrint(msg: string) {
  if (Number(process.env.DEBUG) === 1) {
    console.log(msg);
  }
}

async function scanContractEvents() {
  await createDatabaseIfNeeded();
  const allContracts = await readFile(process.env.TARGET_CONTRACTS);
  const allContractsJSON = JSON.parse(allContracts.toString());
  for (let key in allContractsJSON) {
    let value = allContractsJSON[key];
    work(key, value.contract_address, value.erc1155, value.start_block);
  }
}

scanContractEvents()
