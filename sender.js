import {Address, ProviderRpcClient} from 'everscale-inpage-provider';
import { EverscaleStandaloneClient,
  AccountsStorageContext,
  EverWalletAccount,
  SimpleAccountsStorage,
  SimpleKeystore
} from 'everscale-standalone-client/nodejs.js';
import {deriveBip39Phrase} from "everscale-crypto";
import fs from 'fs';
import { default as core } from "everscale-standalone-client/core.js";
const { nekoton } = core.default;

// this is only for backend
// for frontend keystore and account storage managed by extension
const keyStore = new SimpleKeystore();
const accountStorage = new SimpleAccountsStorage();

const provider = new ProviderRpcClient({
  forceUseFallback: true,
  fallback: () =>
    EverscaleStandaloneClient.create({
      message: {
        retryCount: 1,
        // timeout used to set Expire message described below
        // recommended timeout no more than 3 minutes
        timeout: 60
      },
      connection: {
        id: 42,
        type: 'jrpc',
        data: {
          // jrpc or proto is recommended type of endpoint!!!
          endpoint: 'https://jrpc.everwallet.net',
          // endpoint: 'https://jrpc-testnet.everwallet.net' // for devnet
        },
      },
      // only for backend
      keystore: keyStore,
      accountsStorage: accountStorage
    })
});
await provider.ensureInitialized();

const keys = {
  "secretKey": "172af540e43a524763dd53b26a066d472a97c4de37d5498170564510608250c3",
  "publicKey": "2ada2e65ab8eeab09490e3521415f45b6e42df9c760a639bcf53957550b25a16"
}
const ourWalletAddress = new Address("0:f625baf264c0e270ab4a56614c3316ed7bebc6cff0eb2f3d462dd867830ddf74")

const walletAccount = await EverWalletAccount.fromPubkey({
  publicKey: keys.publicKey
})

if (!walletAccount.address.equals(ourWalletAddress)) {
  throw new Error(`Unexpected EverWallet address. Expected ${ourWalletAddress.toString()} got ${walletAccount.address.toString()}`);
}


// Add our keys to the keystore - provider will search in keystore for private key to sign an external message we send. On frontend keys managed by extension.
keyStore.addKeyPair(keys);
// add our wallet contract instance to the account storage - provider will search for the contract by the 'sender' address we mentioned below. On frontend account storage managed by extension.
accountStorage.addAccount(walletAccount);

const recipient = new Address("0:00ee4a5d98e8e9c4b5dd3e5bf31432e9e95bb53c1db85d45e101779f5420b000");

let transfer = await LoadTransfer();
let tx;

if (!transfer || transfer.status !== 'sending') {
  console.log('create new transfer');
  // create new transfer
  const signedMessage = await walletAccount.prepareMessage({
    recipient: recipient.toString(),
    // 0.1 EVER/VENOM
    amount: '100000000',
    bounce: false,
    // we do not attach any payload to outcoming internal message
    payload: undefined,
    // we do not attach any stateInit to outcoming internal message
    stateInit: undefined,
    // set expire to current time + 4 minutes
    timeout: 240,
    // This field add NetworkId to the data we will sign
    // To make sure your signature can be used only in network you specified
    // Unfortunately in the mainnet this is not used but enabled in other networks
    signatureId: undefined
  }, new AccountsStorageContext(provider.raw._context.clock, provider.raw._context.connectionController, nekoton, provider.raw._context.keystore))

  // we got an object with structure {hash: string, expireAt: ts, boc: string};
  const {state: walletState} = await provider.getFullContractState({address: ourWalletAddress});
  if (!walletState || parseInt(walletState.balance) < 200_000_000) {
    // Please use BigNumber.js in production and not parseInt because js is bad for numbers that can be large.
    throw new Error('Wallet not exist in blockchain or balance too low. Please fulfill it.');
  }

  // now we need to save our pending transaction to the database/filesystem
  // realise that method by yourself
  transfer = {
    signedMessage: signedMessage,
    ltBefore: lastTransactionLtBeforeSending,
    status: 'sending',
    txHash: null
  }
  await SaveTransfer(transfer);
} else {
  console.log('We have pending transfer with status = sending');
  // In case you have use really long expire time it is better to check is message delivered before trying to resend.
  // Because sdk not checked old transaction and if tx is already delivered it will wait until expired before return null.
}


// Try to sent our message
console.log('sending message...');
tx = await provider.raw._context.subscriptionController
  .sendMessage(nekoton.repackAddress(ourWalletAddress.toString()), transfer.signedMessage);

// if tx = null than shardblock ts > expireAt and sdk not found the transaction.
// state.genTimings.genUtime - latest shardblock ts.

// Recheck after sdk manually
// Also in case we RESEND transfer after crash (we loaded pending transfer from the disk) sdk can return null
// even if message delivered because SDK check transactions only happened during sending and message can be delivered
// in previous attempt
if (!tx) {
  const {state} = await provider.getFullContractState({address: ourWalletAddress});

  // Check that shardblock TS is higher than expireAt.
  if (!state || state.genTimings.genUtime < transfer.signedMessage.expireAt) {
    // unreachable because 'sendMessage' must wait until that or return tx
    throw new Error(`Unreachable. ${state.genTimings.genUtime} ${transfer.signedMessage.expireAt}`);
  }

  if(state.lastTransactionId.lt === transfer.ltBefore) {
    console.log('lt of last transaction not changed');
  } else {
    console.log(`fetch transactions from lt ${state.lastTransactionId.lt} down to lt ${transfer.ltBefore}`);
    // Next we will fetch all transactions that happens on account after we send message
    const transactions = await getTransactionsDownToLt(ourWalletAddress, state.lastTransactionId, transfer.ltBefore);
    // We double-check that every transaction in order to avoid any issues with caches
    if (transactions.length === 0 || transactions[0].id.lt !== state.lastTransactionId.lt) {
      throw new Error('Fail to fetch transactions')
    }
    if (transactions.find((tx, index) => index !== transactions.length - 1 && tx.prevTransactionId.lt !== transactions[index + 1].id.lt)) {
      throw new Error('Bad transaction order');
    }

    tx = transactions.find(tx => tx.inMessage.hash === transfer.signedMessage.hash);
  }
}

if (tx) {
  if (tx.outMessages.length !== 1) {
    // No outMessages have created - you have tried to send more coins than account have
    throw new Error('Transaction have not create any outgoing internal messages');
  }
  // Resented successfully
  transfer.status = 'success';
  transfer.txHash = tx.id.hash;
  await SaveTransfer(transfer);
  console.log(`Transfer success, tx hash ${tx.id.hash} message hash ${transfer.signedMessage.hash}`);
} else {
  transfer.status = 'expire';
  await SaveTransfer(transfer);
  console.log(`Transfer expire. Message hash ${transfer.signedMessage.hash}.`);
}

async function SaveTransfer(tx) {
  // This is toy example
  // Please use database
  fs.writeFileSync('pending.json', JSON.stringify(tx));
}

async function LoadTransfer() {
  // This is toy example
  // Please use database
  if (fs.existsSync('pending.json')) {
    return JSON.parse(fs.readFileSync('pending.json').toString('utf-8'));
  }
  return null;
}

async function getTransactionsDownToLt(address, fromContinuation, downToLt) {
  let {transactions, continuation:newContinuation} = await provider.getTransactions({
    address: address,
    limit: 10,
    continuation: fromContinuation
  });

  let targetFound = false;
  transactions.forEach(t => {
    if (t.id.lt === downToLt) {
      targetFound = true;
    }
  });

  if (targetFound) {
    return transactions;
  } else if (!newContinuation) {
    throw new Error(`Transaction with LT ${downToLt} not found on account ${address.toString()}`);
  } else {
    return transactions.concat(await getTransactionsDownToLt(address, newContinuation, downToLt));
  }
}
