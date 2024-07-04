import {Address} from 'everscale-inpage-provider';
import {
  SimpleKeystore
} from 'everscale-standalone-client/nodejs.js';
import { default as core } from "everscale-standalone-client/core.js";
const { nekoton } = core.default;
import BigNumber from 'bignumber.js';

const sender = new Address("0:f625baf264c0e270ab4a56614c3316ed7bebc6cff0eb2f3d462dd867830ddf74");
const recipient = new Address("0:00ee4a5d98e8e9c4b5dd3e5bf31432e9e95bb53c1db85d45e101779f5420b000");

const keys = {
  "secretKey": "172af540e43a524763dd53b26a066d472a97c4de37d5498170564510608250c3",
  "publicKey": "2ada2e65ab8eeab09490e3521415f45b6e42df9c760a639bcf53957550b25a16"
}

const keyStore = new SimpleKeystore();
keyStore.addKeyPair(keys);

const EVER_WALLET_CODE =
  'te6cckEBBgEA/AABFP8A9KQT9LzyyAsBAgEgAgMABNIwAubycdcBAcAA8nqDCNcY7UTQgwfXAdcLP8j4KM8WI88WyfkAA3HXAQHDAJqDB9cBURO68uBk3oBA1wGAINcBgCDXAVQWdfkQ8qj4I7vyeWa++COBBwiggQPoqFIgvLHydAIgghBM7mRsuuMPAcjL/8s/ye1UBAUAmDAC10zQ+kCDBtcBcdcBeNcB10z4AHCAEASqAhSxyMsFUAXPFlAD+gLLaSLQIc8xIddJoIQJuZgzcAHLAFjPFpcwcQHLABLM4skB+wAAPoIQFp4+EbqOEfgAApMg10qXeNcB1AL7AOjRkzLyPOI+zYS/';

const EVER_WALLET_ABI = `{
  "ABI version": 2,
  "version": "2.3",
  "header": ["pubkey", "time", "expire"],
  "functions": [{
    "name": "sendTransaction",
    "inputs": [
      {"name":"dest","type":"address"},
      {"name":"value","type":"uint128"},
      {"name":"bounce","type":"bool"},
      {"name":"flags","type":"uint8"},
      {"name":"payload","type":"cell"}
    ],
    "outputs": []
  }],
  "events": []
}`;

let stateInit = undefined;
// if your wallet is not deployed
// you need to specify stateinit and attach it to the message
// Please do it only for the first outgoing transaction.
let walletDeployed = true;
if (!walletDeployed) {
  stateInit = nekoton.mergeTvc(EVER_WALLET_CODE, nekoton.packIntoCell([
    { name: 'publicKey', type: 'uint256' },
    { name: 'timestamp', type: 'uint64' },
  ], {
    publicKey: new BigNumber(`0x${keys.publicKey}`).toFixed(0),
    timestamp: 0,
  }).boc).boc
}

let clock = new nekoton.ClockWithOffset();
const unsignedMessage = nekoton.createExternalMessage(
  clock,
  nekoton.repackAddress(sender.toString()),
  EVER_WALLET_ABI,
  "sendTransaction",
  stateInit,
  {
    dest: recipient.toString(),
    value: "100000000",
    bounce: false,
    flags: 3,
    payload: ""
  },
  keys.publicKey,
  240, // timeout seconds
);

const signer = await keyStore.getSigner(keys.publicKey);
// signatureId undefinied for everscale mainnet.
// 1 for venom mainnet
const signatureId = undefined;
const signature = await signer.sign(unsignedMessage.hash, signatureId);
const signedMessage = unsignedMessage.sign(signature);

console.log(signedMessage)
