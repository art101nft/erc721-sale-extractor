import Web3 from 'web3';
import BN from 'bignumber.js';
import { promisify } from 'util';
import fs from 'fs';
import pkg from 'sqlite3';
const { Database } = pkg;
import dotenv from 'dotenv';
import { postDiscord } from './posting.js';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

// Use this if you wanna force recreation the initial database
const web3 = new Web3(getWeb3Provider());
const REGENERATE_FROM_SCRATCH = false;
const CHUNK_SIZE = 600; // lower this if geth node is hanging
const RARIBLE_SALE_TOPIC0 = '0xcae9d16f553e92058883de29cb3135dbc0c1e31fd7eace79fef1d80577fe482e';
const OPENSEA_SALE_TOPIC0 = '0xc4109843e0b7d514e4c093114b863f8e7d8d9a458c372cd51bfe526b588006c9';
const LOOKSRARE_SALE_TOPIC0 = '0x95fb6205e23ff6bda16a2d1dba56b9ad7c783f67c96fa149785052f47696f2be';
const X2Y2_SALE_TOPIC0 = '0xe2c49856b032c255ae7e325d18109bc4e22a2804e2e49a017ec0f59f19cd447b';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const readFile = promisify(fs.readFile);
console.log(`opening database at ${process.env.WORK_DIRECTORY + process.env.DATABASE_FILE}`);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);

async function work(contractName, contractAddress, isERC1155, startBlock) {
  console.log(`Starting work for ${contractName} (is ERC1155: ${isERC1155})`);
  let abi;
  let eventName;
  const lastFile = `${process.env.WORK_DIRECTORY}${contractName}.last.txt`;
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
  let last = retrieveCurrentBlockIndex(contractName, startBlock);
  const json = JSON.parse(abi.toString());
  const contract = new web3.eth.Contract(
    json,
    contractAddress,
  );
  console.log(`${contractName} - starting from block: ${last.toString()}`);
  let latest = await web3.eth.getBlockNumber();
  while (last < parseInt(latest)) {
    try {
      const block = await web3.eth.getBlock(last);
      const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
      fs.writeFileSync(lastFile, last.toString());
      const lastRequested = last;
      const events = await contract.getPastEvents(eventName, {
        fromBlock: last,
        toBlock: last + CHUNK_SIZE, // handle blocks by chunks
      });
      if (events.length > 0) console.log(`\n${contractName} - handling ${events.length} events from block ${last} [${blockDate.toISOString()}]`);
      for (const ev of events) {
        last = ev.blockNumber;
        // Skip tx logs if already exists in DB
        const rowExists = await checkRowExists(ev.transactionHash, ev.logIndex, contractAddress);
        if (rowExists) {
          process.stdout.write('.');
          continue
        };
        const tr = await web3.eth.getTransactionReceipt(ev.transactionHash);
        const txBlock = await web3.eth.getBlock(tr.blockNumber);
        const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
        let amountWei = 0;
        let eventType = 'transfer';
        let eventSource = 'contract';
        let storeEvent = false;
        let tokenId;
        let fromAddress;
        let toAddress;
        let logIndex;
        let txHash;
        for (const l of tr.logs) {
          // If we have a transfer, the one after will be the sale
          if (l.topics[0] === TRANSFER_TOPIC) {
            tokenId = parseInt(l.topics[3], 16);
            let fromAddressBytes = web3.utils.hexToBytes(l.topics[1]);
            let toAddressBytes = web3.utils.hexToBytes(l.topics[2]);
            fromAddress = web3.utils.bytesToHex(fromAddressBytes.slice(12));
            toAddress = web3.utils.bytesToHex(toAddressBytes.slice(12));
            logIndex = l.logIndex;
            txHash = l.transactionHash;
            storeEvent = true;
          }
          if (fromAddress == '0x0000000000000000000000000000000000000000') eventType = 'mint'
          // check for known sale topics
          if (l.topics[0] === RARIBLE_SALE_TOPIC0
            || l.topics[0] === OPENSEA_SALE_TOPIC0
            || l.topics[0] === LOOKSRARE_SALE_TOPIC0
            || l.topics[0] === X2Y2_SALE_TOPIC0
          ) {
            eventType = 'sale';
            storeEvent = true;
            logIndex = l.logIndex;
            if (l.topics[0] === OPENSEA_SALE_TOPIC0) {
              const data = l.data.substring(2);
              const dataSlices = data.match(/.{1,64}/g);
              amountWei = parseInt(dataSlices[2], 16);
              eventSource = 'opensea';
            } else if (l.topics[0] === X2Y2_SALE_TOPIC0) {
              const data = l.data.substring(2)
              const dataSlices = data.match(/.{1,64}/g);
              amountWei = parseInt(dataSlices[3], 16);
              eventSource = 'x2y2';
            } else if (l.topics[0] === LOOKSRARE_SALE_TOPIC0) {
              const data = l.data.substring(2);
              const dataSlices = data.match(/.{1,64}/g);
              amountWei = parseInt(dataSlices[6], 16);
              eventSource = 'looksrare';
            } else if (l.topics[0] === RARIBLE_SALE_TOPIC0) {
              const data = l.data.substring(2);
              const dataSlices = data.match(/.{1,64}/g);
              if (dataSlices.length < 12) {
                continue;
              }
              const amount = tr.logs.filter((t) => {
                if (t.topics[0] === RARIBLE_SALE_TOPIC0) {
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
              amountWei = amount;
              eventSource = 'rarible';
            }
            // sale found, notify discord and twitter
            try {
              const amountEther = web3.utils.fromWei(amountWei.toString(), 'ether');
              await postDiscord(
                contractName,
                contractAddress,
                tokenId,
                amountEther,
                eventSource,
                fromAddress,
                toAddress,
                txHash,
                blockDate.getTime()
              )
            } catch(err) {
              console.log(`\n[!] Problem posting! ${err}`)
            }
          }
          if (storeEvent) {
            if (eventType == 'transfer') {
              process.stdout.write('-');
            } else if (eventType == 'mint') {
              process.stdout.write('o');
            } else if (eventType == 'sale') {
              process.stdout.write('x');
            }
            await writeToDatabase(
              txHash,
              logIndex,
              contractName,
              contractAddress,
              eventType,
              eventSource,
              fromAddress,
              toAddress,
              tokenId,
              amountWei,
              txDate
            );
          }
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

function retrieveCurrentBlockIndex(contractName, startBlock) {
  let last = 0;
  const lastFile = `${process.env.WORK_DIRECTORY}${contractName}.last.txt`;
  if (fs.existsSync(lastFile)) {
    last = parseInt(fs.readFileSync(lastFile).toString(), 10);
  } else {
    fs.writeFileSync(lastFile, startBlock.toString());
  };
  // contract creation
  if (Number.isNaN(last) || last < startBlock) {
    last = startBlock
  };
  console.log(`\nFound last block ${last} for ${contractName}`)
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

async function sleep(msec) {
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

async function checkRowExists(txHash, logIndex, contractAddress) {
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

async function writeToDatabase(txHash, logIndex, contractName, contractAddress, eventName, eventSource, sourceOwner, targetOwner, tokenId, amount, txDate) {
  const rowExists = await checkRowExists(txHash, logIndex, contractAddress);
  if (!rowExists) {
    let stmt;
    try {
      debugPrint(`\n${contractName} - ${txDate.toLocaleString()} - storing event '${eventName}' from '${sourceOwner}' to '${targetOwner}' via '${eventSource}' for token ${tokenId} for ${web3.utils.fromWei(amount.toString(), 'ether')}Ξ in tx ${txHash} log index ${logIndex}.`);
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
}

function debugPrint(msg) {
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
    if (!value.scan && process.env.DEBUG == 1) continue
    work(key, value.contract_address, value.erc1155, value.start_block);
  }
}

scanContractEvents()
