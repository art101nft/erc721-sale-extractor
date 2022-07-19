#!/usr/bin/env ts-node
/* eslint-disable no-shadow */
/* eslint-disable no-loop-func */
/* eslint-disable prefer-destructuring */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-use-before-define */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */

import { Database } from 'sqlite3';
import Web3 from 'web3';
import dotenv from 'dotenv';
import fs from 'fs';
import { RequestInfo, RequestInit } from 'node-fetch';
const fetch = (url: RequestInfo, init?: RequestInit) => import('node-fetch').then(({ default: fetch }) => fetch(url, init));

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const assetsBase = 'https://art101-assets.s3.us-west-2.amazonaws.com';

export async function postDiscord(
  contractName:string,
  contractAddress:string,
  tokenIndex:number,
  amountEther:string,
  eventSource:string,
  fromAddress:string,
  toAddress:string
) {
  try {
    const msg = `New sale for ${contractName}! Purchased by ${shortenAddress(toAddress)} for ${amountEther}Ξ on ${camelCase(eventSource)}`;
    // const imageURL = await getOffchainImageURL(contractAddress, tokenIndex);
    const url = `${assetsBase}/${contractAddress}/${tokenIndex.toString()}.json`;
    // const metadata = await getOffchainMetadata(url);
    const metadata:{[key:string]:any} = await fetch(url)
      .then((r) => r.json())
      .then((r) => {
        return r
      });
    const imageURL = metadata.image.replace('ipfs://', `${assetsBase}/${contractAddress}/`)
    const res = await fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [
          {
            title: msg,
            description: 'ok, cool',
            image: {
              url: imageURL
            }
          }
        ]
      })
    }).then((r) => r.json());
    console.log(res);
  } catch(err) {
    console.log(err);
  }
}

function camelCase(s:string):string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortenAddress(address:string): string {
  const shortAddress = `${address.slice(0, 6)}...${address.slice(address.length - 4, address.length)}`;
  if (address.startsWith('0x')) return shortAddress;
  return address;
}
