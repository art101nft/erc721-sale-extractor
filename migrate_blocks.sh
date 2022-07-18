#!/bin/bash

function migrate_contract() {
  echo -e "[+] Migrating ${1} lastFile to ${2}"
  mv storage/${1}.last.txt storage/${2}.last.txt
}

migrate_contract 0xdc8bEd466ee117Ebff8Ee84896d6aCd42170d4bB non-fungible-soup
migrate_contract 0x7f81858ea3b43513adfaf0a20dc7b4c6ebe72919 mondriannft
migrate_contract 0x0dD0CFeAE058610C88a87Da2D9fDa496cFadE108 soupxmondrian
migrate_contract 0x62C1e9f6830098DFF647Ef78E1F39244258F7bF5 bauhausblocks
migrate_contract 0xc918F953E1ef2F1eD6ac6A0d2Bf711A93D20Aa2b nftzine
migrate_contract 0xea2dc6f116a4c3d6a15f06b4e8ad582a07c3dd9c basedvitalik
migrate_contract 0x6c61fB2400Bf55624ce15104e00F269102dC2Af4 rmutt
