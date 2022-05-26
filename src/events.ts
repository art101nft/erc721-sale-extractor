#!/usr/bin/env ts-node
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

const REGENERATE_FROM_SCRATCH = false;
const readFile = promisify(fs.readFile);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);
const provider = getWeb3Provider();
const web3 = new Web3(provider);
const contractEvents = [
  'TokenTransfer',
  'TokenOffered',
  'TokenBidEntered',
  'TokenBidWithdrawn',
  'TokenBought',
  'TokenNoLongerForSale',
  'CollectionUpdated',
  'CollectionDisabled',
]

async function work(eventName:string) {
  const lastFile = process.env.WORK_DIRECTORY + `marketplace.${eventName}.last.txt`;
  const abi = await readFile(process.env.MARKETPLACE_ABI as string);
  const json = JSON.parse(abi.toString());
  const contract = new web3.eth.Contract(
    json,
    process.env.MARKETPLACE_CONTRACT,
  );
  let latest = await web3.eth.getBlockNumber();
  if (REGENERATE_FROM_SCRATCH) {
    fs.unlinkSync(lastFile);
  }
  let last = retrieveCurrentBlockIndex(lastFile);
  console.log(`${eventName} - starting from block ${last}`);
  while (last < latest) {
    const block = await web3.eth.getBlock(last);
    const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
    await sleep(200);
    console.log(`${eventName} - retrieving events from block ${last} - ${blockDate.toISOString()}`);
    fs.writeFileSync(lastFile, last.toString());

    const events = await contract.getPastEvents(eventName, {
      fromBlock: last,
      toBlock: last + 500, // handle blocks by chunks
    });
    console.log(`${eventName} - handling ${events.length} events...`);
    let lastEvent = null;
    for (const ev of events) {
      lastEvent = ev;
      process.stdout.write('.');
      last = ev.blockNumber;

      const rowExists = await new Promise((resolve) => {
        db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, ev.returnValues.collectionAddress], (err, row) => {
          if (err) {
            resolve(false);
          }
          resolve(row !== undefined);
        });
      });
      if (rowExists) {
        console.log(`Event already stored (tx: ${ev.transactionHash}, log idx: ${ev.logIndex}, contract: ${ev.returnValues.collectionAddress})`);
        continue;
      };

      const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
      const txBlock = await web3.eth.getBlock(ev.blockNumber);
      const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
      const platform = 'art101-marketplace'

      // Different SQL query based upon the event type
      console.log(`issuing SQL statement for ${eventName} event...`);
      console.log(ev)
      if (eventName == 'TokenTransfer') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          ev.returnValues.from.toLowerCase(),
          ev.returnValues.to.toLowerCase(),
          ev.returnValues.tokenIndex,
          0,
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'TokenOffered') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          'owner',
          ev.returnValues.toAddress.toLowerCase(),
          ev.returnValues.tokenIndex,
          parseFloat(new BN(ev.returnValues.minValue.toString()).toString()),
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'TokenBidEntered') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          ev.returnValues.fromAddress.toLowerCase(),
          'na',
          ev.returnValues.tokenIndex,
          parseFloat(new BN(ev.returnValues.value.toString()).toString()),
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'TokenBidWithdrawn') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          ev.returnValues.fromAddress.toLowerCase(),
          'na',
          ev.returnValues.tokenIndex,
          parseFloat(new BN(ev.returnValues.value.toString()).toString()),
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'TokenBought') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          ev.returnValues.fromAddress.toLowerCase(),
          ev.returnValues.toAddress.toLowerCase(),
          ev.returnValues.tokenIndex,
          parseFloat(new BN(ev.returnValues.value.toString()).toString()),
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'TokenNoLongerForSale') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          'na',
          'na',
          ev.returnValues.tokenIndex,
          0,
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'CollectionUpdated') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          'na',
          'na',
          0,
          0,
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      } else if (eventName == 'CollectionDisabled') {
        stmt.run(
          ev.returnValues.collectionAddress,
          eventName.toLowerCase(),
          'na',
          'na',
          0,
          0,
          txDate.toISOString(),
          ev.transactionHash,
          ev.logIndex,
          platform
        );
      }

      // Save last block
      console.log(`${eventName} - saving block ${latest}`)
      fs.writeFileSync(lastFile, last.toString());
    }

    // prevent an infinite loop on an empty set of block
    // @ts-ignore: Object is possibly 'null'.
    if (lastEvent === null || last === lastEvent.blockNumber) {
      last += 200;
    }

    while (last >= latest) {
      latest = await web3.eth.getBlockNumber();
      console.log(`${eventName} - waiting for new blocks, last:`, last, ', latest:', latest, '...');
        // wait for new blocks (300 seconds)
        await sleep(300000);
    }
  }
}

function retrieveCurrentBlockIndex(lastFile:string):number {
  let last:number = 0;
  const startBlock = Number(process.env.STARTING_BLOCK_MARKETPLACE);
  if (fs.existsSync(lastFile)) {
    last = parseInt(fs.readFileSync(lastFile).toString(), 10);
  } else {
    fs.writeFileSync(lastFile, startBlock);
  };
  // contract creation
  if (Number.isNaN(last) || last < startBlock) {
    last = startBlock
  };
  return last;
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

async function sleep(msec:number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, msec));
}

// Loop through contract events to capture everything
for (const eventName of contractEvents) {
  work(eventName);
}
