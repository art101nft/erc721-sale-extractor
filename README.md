# ERC-721/1155 Sales Extractor

This repo contains TypeScript code to scrape the Ethereum chain for sales for any number of ERC-721 or ERC-1155 compliant tokens. It was graciously developed by [@tat2bu](https://twitter.com/tat2bu) for the CryptoPhunks project and their [marketplace site](https://notlarvalabs.com/cryptophunks) and forked/modified by [@lza_menace](https://twitter.com/lza_menace) to support multiple collections.

The `main.ts` script scrapes the blockchain data and extracts structured information about sales of one or more contracts as defined in [data/contracts.json](data/contracts.json.sample) into a SQLite database. It currently supports Opensea, LooksRare, Cargo, Rarible, and NFTX sales.

The extracted data is structured the following way in the generated sqlite3 database:

```
------------------
events
------------------
contract    TEXT
event_type  TEXT
from_wallet TEXT
to_wallet   TEXT
token_id    NUMBER
amount      NUMBER
tx_date     TEXT
tx          TEXT
platform    TEXT
```

It restarts where it stopped, if you want to start from the beginning, change the value of the `REGENERATE_FROM_SCRATCH` constant.

## Setup

### Secrets

Copy the `.env` file to `.env.local` to setup your local configuration, you'll need a geth node (Infura and Alchemy provide this with good free tiers). Then start the scraper using `ts-node`: `npx ts-node src/main.ts` or `npm run worker-main`.

### Contracts

Copy the `data/contracts.json.sample` file to `data/contracts.json` and modify it for the contracts you want to scrape. Be sure to define if the contract is ERC-721 or ERC-1155 to use the proper ABI and event source.

## API

An API that serves the scraped data is implemented in the `src/server.js` file, for now, it serves a few endpoints:
* `/api/contracts` - parses the `data/contracts.json` file to return stored contract details.
* `/api/token/:contractAddress/:tokenId/history` - queries the SQLite database to return events for ${tokenId} in ${contractAddress} passed in the URL.
* `/api/latest` - queries the SQLite database to return the latest event (limited to 1).
* `/api/:contractAddress/data` - queries the SQLite database to return sales events from ${contractAddress} passed in the URL.
* `/api/:contractAddress/platforms` - queries the SQLite database to return sales events based upon the platform where the sale took place from ${contractAddress} passed in the URL.

You can start it using `npm run serve` or `npm start`, the latter of which will concurrently start the scraping processes as well as the web server.

The root of the web service is a simple representation of the sales events using [chart.js](https://chartjs.org/) and the above API.

## Docker

A Dockerfile is provided. You can override the `.env` environment variables to configure the container. The simplest startup options are shown below:

```
docker build -t sales-events-scraper .
docker run -it -e WORK_DIRECTORY=/app/work/ -v /tmp/work:/app/work -p 3000:3000 sales-events-scraper
```

## Todo

- Better code structure using callbacks, so this could be used for other purposes (like a sales bot)
- Extract specific traits from the tokens into the database and index them.
