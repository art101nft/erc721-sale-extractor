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


/// Use this if you wanna force recreation the initial database
const REGENERATE_FROM_SCRATCH = false;
const CHUNK_SIZE = 200; // lower this if geth node is hanging
const RARIBLE_TOPIC0 = '0xcae9d16f553e92058883de29cb3135dbc0c1e31fd7eace79fef1d80577fe482e';
const NFTX_TOPIC0 = '0xf7735c8cb2a65788ca663fc8415b7c6a66cd6847d58346d8334e8d52a599d3df';
const NFTX_ALTERNATE_TOPIC0 = '0x1cdb5ee3c47e1a706ac452b89698e5e3f2ff4f835ca72dde8936d0f4fcf37d81';
const NFTX_TRANSFER_TOPIC0 = '0x63b13f6307f284441e029836b0c22eb91eb62a7ad555670061157930ce884f4e';
const NFTX_SELL_TOPIC0 = '0x1cdb5ee3c47e1a706ac452b89698e5e3f2ff4f835ca72dde8936d0f4fcf37d81';
const CARGO_TOPIC0 = '0x5535fa724c02f50c6fb4300412f937dbcdf655b0ebd4ecaca9a0d377d0c0d9cc';
const PHUNK_MARKETPLACE_TOPIC0 = '0x975c7be5322a86cddffed1e3e0e55471a764ac2764d25176ceb8e17feef9392c';
const OPENSEA_SALE_TOPIC0 = '0xc4109843e0b7d514e4c093114b863f8e7d8d9a458c372cd51bfe526b588006c9';
const LOOKSRARE_SALE_TOPIC0 = '0x95fb6205e23ff6bda16a2d1dba56b9ad7c783f67c96fa149785052f47696f2be';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const readFile = promisify(fs.readFile);
console.log(`opening database at ${process.env.WORK_DIRECTORY + process.env.DATABASE_FILE}`);
let db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE);

async function work(contractAddress:string, isERC1155:boolean, startBlock:number) {
  console.log(`Starting work for contract ${contractAddress} (is ERC1155: ${isERC1155})`);
  await sleep(5);
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
    console.log(`Using ERC-1155 ABI for contract ${contractAddress} - searching for ${eventName} events.`);
  } else {
    abi = await readFile(process.env.ERC721_ABI);
    eventName = 'Transfer';
    console.log(`Using ERC-721 ABI for contract ${contractAddress} - searching for ${eventName} events.`);
  }
  let last = retrieveCurrentBlockIndex(contractAddress, startBlock);
  const json = JSON.parse(abi.toString());
  // const provider = getWeb3Provider();
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
  const web3 = new Web3(provider);
  const contract = new web3.eth.Contract(
    json,
    contractAddress,
  );
  console.log(`${contractAddress} - starting from block: ${last}`);
  let latest = await web3.eth.getBlockNumber();
  while (last < latest) {
    try {
      const block = await web3.eth.getBlock(last);
      const blockDate = new Date(parseInt(block.timestamp.toString(), 10) * 1000);
      await sleep(10);
      console.log(`\n${contractAddress} - retrieving events from block ${last} - ${blockDate.toISOString()}`);

      const lastRequested = last;
      const events = await contract.getPastEvents(eventName, {
        fromBlock: last,
        toBlock: last + CHUNK_SIZE, // handle blocks by chunks
      });
      console.log(`${contractAddress} - handling ${events.length} events...`);
      for (const ev of events) {

        process.stdout.write('.')
        last = ev.blockNumber;
        if (fs.readFileSync(lastFile).toString() != last.toString()) {
          fs.writeFileSync(lastFile, last.toString());
        }

        const rowExists = await new Promise((resolve) => {
          db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
            if (err) {
              resolve(false);
            }
            resolve(row !== undefined);
          });
        });
        if (rowExists) {
          console.log(`\nEvent already stored (tx: ${ev.transactionHash}, log idx: ${ev.logIndex}, contract: ${contractAddress})`);
          continue;
        };

        const tr = await web3.eth.getTransactionReceipt(ev.transactionHash);
        let saleFound = false;
        const txBlock = await web3.eth.getBlock(tr.blockNumber);
        const txDate = new Date(parseInt(txBlock.timestamp.toString(), 10) * 1000);
        for (const l of tr.logs) {
          // check matching element to get date
          if (l.topics[0] === RARIBLE_TOPIC0
            || l.topics[0] === NFTX_TOPIC0
            || l.topics[0] === NFTX_ALTERNATE_TOPIC0
            || l.topics[0] === CARGO_TOPIC0
            || l.topics[0] === PHUNK_MARKETPLACE_TOPIC0
            || l.topics[0] === OPENSEA_SALE_TOPIC0
            || l.topics[0] === LOOKSRARE_SALE_TOPIC0) {
            saleFound = true;
          }
          if (l.topics[0] === OPENSEA_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = parseInt(dataSlices[2], 16);
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            /*
            db.run('DELETE FROM events WHERE tx = ? AND log_index = ?',
            ev.transactionHash, ev.logIndex);
            */
            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              console.log(contractAddress, ev.transactionHash, ev.logIndex);
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'opensea');
              stmt.finalize();
            } else {
              console.log('already exist! we have to debug that!');
            }
            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed an opensea sale for token #${tokenId} to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}\n`);
          } else if (l.topics[0] === LOOKSRARE_SALE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = parseInt(dataSlices[6], 16);
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'looksrare');
              stmt.finalize();
            }
            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed a looksrare sale for token #${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === PHUNK_MARKETPLACE_TOPIC0) {
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const amount = parseInt(dataSlices[0], 16);
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'phunkmarket');
              stmt.finalize();
            }
            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed a phunk market place sale for token #${tokenId} to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}.`);
          } else if (l.topics[0] === RARIBLE_TOPIC0) {
            // rarible
            // 1 -> to
            // 6 -> amount
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);
            const tokenId = ev.returnValues.tokenId;
            // TODO maybe find a better way to identify the proper slice
            if (dataSlices.length < 12) {
              // not the right data slice
              continue;
            }

            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
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

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'rarible');
              stmt.finalize();
            }
            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed a rarible sale to ${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}`);
            break;
          } else if (l.topics[0] === NFTX_TOPIC0
            || l.topics[0] === NFTX_ALTERNATE_TOPIC0) {
            // nftx sale
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);

            let relevantTopic = tr.logs.filter((t) => {
              if (t.topics[0] === NFTX_TRANSFER_TOPIC0) {
                return true;
              }
              return false;
            });
            let amount = -1;
            if (relevantTopic.length === 0) {
              console.log('\nswap operation, skipping, finding amount elsewhere');
              relevantTopic = tr.logs.filter((t) => {
                if (t.topics[0] === NFTX_SELL_TOPIC0) {
                  return true;
                }
                return false;
              });
              if (relevantTopic.length === 0) {
                console.log('cannot find amount!!');
                break;
              }
              const relevantData = relevantTopic[0].data.substring(2);
              const relevantDataSlice = relevantData.match(/.{1,64}/g);
              amount = parseInt(relevantDataSlice[1], 16);
            }
            // we should use the event directly for that
            const tokenId = ev.returnValues.tokenId;
            const targetOwner = ev.returnValues.to.toLowerCase();
            const sourceOwner = ev.returnValues.from.toLowerCase();
            amount = parseInt(dataSlices[1], 16);

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, parseFloat(new BN(amount.toString()).toString()), txDate.toISOString(), ev.transactionHash, ev.logIndex, 'nftx');
              stmt.finalize();
            }
            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed a nftx sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}`);
            break;
          } else if (l.topics[0] === CARGO_TOPIC0) {
            // cargo sale
            const data = l.data.substring(2);
            const dataSlices = data.match(/.{1,64}/g);

            const sourceOwner = dataSlices[12].replace(/^0+/, '').toLowerCase();
            const targetOwner = `0x${dataSlices[0].replace(/^0+/, '')}`.toLowerCase();
            const amount = parseInt(dataSlices[15], 16);
            const tokenId = parseInt(dataSlices[10], 16);
            const commission = parseInt(dataSlices[16], 16);

            const amountFloat = new BN(amount.toString())
              .plus(new BN(commission.toString())).toNumber();

            const rowExists = await new Promise((resolve) => {
              db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
                if (err) {
                  resolve(false);
                }
                resolve(row !== undefined);
              });
            });
            if (!rowExists) {
              const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
              stmt.run(contractAddress, 'sale', sourceOwner, targetOwner, tokenId, amountFloat, txDate.toISOString(), ev.transactionHash, ev.logIndex, 'cargo');
              stmt.finalize();
            }

            console.log(`\n${contractAddress} - ${txDate.toLocaleString()} - indexed a cargo sale to 0x${targetOwner} for ${web3.utils.fromWei(amount.toString(), 'ether')}eth in tx ${tr.transactionHash}`);
            break;
          }
        }

        if (!saleFound) {
          // no sale found, index a transfer event
          const rowExists = await new Promise((resolve) => {
            db.get('SELECT * FROM events WHERE tx = ? AND log_index = ? AND contract = ?', [ev.transactionHash, ev.logIndex, contractAddress], (err, row) => {
              if (err) {
                resolve(false);
              }
              resolve(row !== undefined);
            });
          });
          if (!rowExists) {
            const stmt = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
            stmt.run(contractAddress, 'transfer', ev.returnValues.from, ev.returnValues.to, ev.returnValues.tokenId, 0, txDate.toISOString(), ev.transactionHash, ev.logIndex, 'unknown');
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
        console.log('\n', contractAddress, ' - waiting for new blocks, last:', last, ', latest:', latest, '...');
          // wait for new blocks (300 seconds)
          await sleep(300000);
      }
    } catch (err) {
      console.log('error received, will try to continue', err);
    }
  }
  console.log('\nended should tail now');
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
  console.log(`Found last block ${last} for ${contractAddress}`)
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
    if (fs.existsSync(process.env.DATABASE_FILE)) fs.unlinkSync(process.env.DATABASE_FILE);
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

async function scanContractEvents() {
  await createDatabaseIfNeeded();
  const allContracts = await readFile(process.env.TARGET_CONTRACTS);
  const allContractsJSON = JSON.parse(allContracts.toString());
  for (let key in allContractsJSON) {
    let value = allContractsJSON[key];
    work(value.contract_address, value.erc1155, value.start_block);
  }
}

scanContractEvents()
