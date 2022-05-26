/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
const Database = require('better-sqlite3');
const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else {
  console.warn('no .env.local find found, using default config');
  dotenv.config();
}

const db = new Database(process.env.WORK_DIRECTORY + process.env.DATABASE_FILE, { verbose: console.log });
const contracts = JSON.parse(fs.readFileSync(process.env.TARGET_CONTRACTS).toString())

app.use(express.json());

app.use('/', express.static('public'));

app.use('/app', express.static('public'));

app.get('/api/contracts', (req, res) => {
  res.status(200).json(contracts)
})

app.get('/api/:contractAddress/events', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select *
    from events
    where contract = '${req.params.contractAddress}'
    and event_type != 'sale' and event_type != 'transfer'
    order by tx_date desc
    `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});

app.get('/api/token/:contractAddress/:tokenId/history', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select *
    from events
    where token_id = ${req.params.tokenId}
    and contract = '${req.params.contractAddress}'
    order by tx_date desc
    `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});

app.get('/api/latest', (req, res) => {
  const stmt = db.prepare(`select *
    from events
    order by tx_date desc
    limit 1
    `);
  res.status(200).json(stmt.get());
});

app.get('/api/:contractAddress/data', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select
        date(tx_date) date,
        sum(amount/1000000000000000000.0) volume,
        avg(amount/1000000000000000000.0) average_price,
        (select avg(amount/1000000000000000000.0) from (select * from events
          where event_type == 'sale'
          and contract = '${req.params.contractAddress}'
          and date(tx_date) = date(ev.tx_date)
          order by amount
          limit 10)) floor_price,
        count(*) sales
    from events ev
    where event_type == 'sale'
    and contract = '${req.params.contractAddress}'
    group by date(tx_date)
    order by date(tx_date)
    `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});

app.get('/api/:contractAddress/platforms', (req, res) => {
  const results = [];
  const stmt = db.prepare(`select platform,
    sum(amount/1000000000000000000.0) volume,
    count(*) sales
    from events
    where event_type = 'sale'
    and contract = '${req.params.contractAddress}'
    group by platform
    order by sum(amount/1000000000000000000.0) desc
  `);
  for (const entry of stmt.iterate()) {
    results.push(entry);
  }
  res.status(200).json(results);
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
