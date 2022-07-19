import dotenv from 'dotenv';
import fs from 'fs';
import fetch from 'node-fetch';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const assetsBase = 'https://art101-assets.s3.us-west-2.amazonaws.com';

export async function postDiscord(contractName, contractAddress, tokenIndex, amountEther, eventSource, fromAddress, toAddress, txHash, timestamp) {
  if (process.env.DISCORD_ACTIVE == 0) return
  try {
    const title = `Sale of token ${tokenIndex} for ${contractName}!`;
    const desc = `Purchased by ${shortenAddress(toAddress)} at <t:${timestamp}> for ${amountEther}Ξ on ${camelCase(eventSource)}`;
    const url = `${assetsBase}/${contractAddress}/${tokenIndex.toString()}.json`;
    const metadata = await fetch(url)
      .then((r) => r.json());
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
            title: title,
            description: desc,
            image: {
              url: imageURL
            },
            url: `https://etherscan.io/tx/${txHash}`
          }
        ]
      })
    });
    process.stdout.write('*')
  } catch(err) {
    throw new Error(`[!] Failed to post to Discord: ${err}`);
  }
}

function camelCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortenAddress(address) {
  const shortAddress = `${address.slice(0, 6)}...${address.slice(address.length - 4, address.length)}`;
  if (address.startsWith('0x')) return shortAddress;
  return address;
}
