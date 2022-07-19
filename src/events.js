import Web3 from 'web3';
import BN from 'bignumber.js';
import { promisify } from 'util';
import fs from 'fs';
import pkg from 'sqlite3';
const { Database } = pkg;
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

async function work(eventName) {
  const lastFile = process.env.WORK_DIRECTORY + `marketplace.${eventName}.last.txt`;
  const abi = await readFile(process.env.MARKETPLACE_ABI);
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
  console.log(`Art101 Marketplace - ${eventName} - starting from block ${last}`);
  while (last < latest) {
    const block = await web3.eth.getBlock(last);
    const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
    await sleep(200);
    fs.writeFileSync(lastFile, last.toString());

    const events = await contract.getPastEvents(eventName, {
      fromBlock: last,
      toBlock: last + 500, // handle blocks by chunks
    });
    if (events.length == 0) continue;
    console.log(`\nArt101 Marketplace - ${eventName} - handling ${events.length} events from block ${last} +500 [${blockDate.toISOString()}]`);
    let lastEvent = null;
    for (const ev of events) {
      lastEvent = ev;
      process.stdout.write('.');
      last = ev.blockNumber;

      const rowExists = await new Promise((resolve) => {
        db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, ev.returnValues.collectionAddress.toLowerCase()], (err, row) => {
          if (err) {
            resolve(false);
          }
          resolve(row !== undefined);
        });
      });
      if (rowExists) {
        console.log(`Event already stored (tx: ${ev.transactionHash}, log idx: ${ev.logIndex}, contract: ${ev.returnValues.collectionAddress.toLowerCase()})`);
        continue;
      };

      const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
      const txBlock = await web3.eth.getBlock(ev.blockNumber);
      const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);

      // Query data
      let _address = ev.returnValues.collectionAddress.toLowerCase();
      let _event = eventName.toLowerCase();
      let _from;
      let _to;
      let _idx = ev.returnValues.tokenIndex;
      let _amt;
      let _date = txDate.toISOString();
      let _tx = ev.transactionHash;
      let _log = ev.logIndex;
      let _platform = 'art101-marketplace'


      // Different SQL query based upon the event type
      console.log(`issuing SQL statement for ${eventName} event...`);
      // console.log(ev)
      if (eventName == 'TokenTransfer') {
        _from = ev.returnValues.from.toLowerCase();
        _to = ev.returnValues.to.toLowerCase();
        _amt = 0;
      } else if (eventName == 'TokenOffered') {
        _from = 'owner';
        _to = ev.returnValues.toAddress.toLowerCase();
        _amt = parseFloat(new BN(ev.returnValues.minValue.toString()).toString());
      } else if (eventName == 'TokenBidEntered') {
        _from = ev.returnValues.fromAddress.toLowerCase();
        _to = 'owner';
        _amt = parseFloat(new BN(ev.returnValues.value.toString()).toString());
      } else if (eventName == 'TokenBidWithdrawn') {
        _from = ev.returnValues.fromAddress.toLowerCase();
        _to = 'owner';
        _amt = parseFloat(new BN(ev.returnValues.value.toString()).toString());
      } else if (eventName == 'TokenBought') {
        _from = ev.returnValues.fromAddress.toLowerCase();
        _to = ev.returnValues.toAddress.toLowerCase();
        _amt = parseFloat(new BN(ev.returnValues.value.toString()).toString());
      } else if (eventName == 'TokenNoLongerForSale') {
        _from = 'owner';
        _to = 'owner';
        _amt = 0;
      } else if (eventName == 'CollectionUpdated') {
        _from = 'owner';
        _to = 'owner';
        _amt = 0;
      } else if (eventName == 'CollectionDisabled') {
        _from = 'owner';
        _to = 'owner';
        _amt = 0;
      }

      stmt.run(
        _address,
        _event,
        _from,
        _to,
        _idx,
        _amt,
        _date,
        _tx,
        _log,
        _platform
      );

      // Save last block
      console.log(`${eventName} - saving block ${latest}`)
      fs.writeFileSync(lastFile, last.toString());
    }

    // prevent an infinite loop on an empty set of block
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

function retrieveCurrentBlockIndex(lastFile) {
  let last = 0;
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

async function sleep(msec) {
  return new Promise((resolve) => setTimeout(resolve, msec));
}

// Loop through contract events to capture everything
for (const eventName of contractEvents) {
  work(eventName);
}
