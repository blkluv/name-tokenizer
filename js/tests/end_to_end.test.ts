import { afterAll, beforeAll, expect, jest, test } from "@jest/globals";
import { ChildProcess } from "child_process";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  spawnLocalSolana,
  signAndSendTransactionInstructions,
  sleep,
} from "./utils";
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TokenMint } from "./utils";
import {
  createNameRegistry,
  getNameAccountKey,
  getHashedName,
} from "@bonfida/spl-name-service";
import crypto from "crypto";
import fs from "fs";
import {
  createCentralState,
  createMint,
  createNft,
  redeemNft,
  withdrawTokens,
  NAME_TOKENIZER_ID_DEVNET,
} from "../src/bindings";
import { CentralState, Tag, MINT_PREFIX, NftRecord } from "../src/state";
import { Metadata } from "@metaplex-foundation/mpl-token-metadata";

// Global state initialized once in test startup and cleaned up at test
// teardown.
let solana: ChildProcess;
let connection: Connection;
let feePayer: Keypair;
let payerKeyFile: string;
let programId: PublicKey;

beforeAll(async () => {
  solana = await spawnLocalSolana();
  connection = new Connection("https://api.devnet.rpcpool.com/", "finalized");
  feePayer = Keypair.fromSecretKey(new Uint8Array([]));
  programId = NAME_TOKENIZER_ID_DEVNET;
});

afterAll(() => {
  if (solana !== undefined) {
    try {
      solana.kill();
    } catch (e) {
      console.log(e);
    }
  }
});

jest.setTimeout(1_500_000);

/**
 * Test scenario
 *
 * (1) Create central state
 * (2) Create mint
 * (3) Create NFT
 * (4) Send funds to the tokenized domain (tokens + SOL)
 * (5) Withdraw funds
 * (6) Transfer NFT to new wallet
 * (7) Sends funds to the tokenized domain (tokens + SOL)
 * (8) Withdraw funds
 * (9) Sends funds to the tokenized domain (tokens + SOL)
 * (10) Redeem NFT
 * (11) Withdraw funds
 * (12) Create NFT again
 * (13) Verify metadata
 */

test("End to end test", async () => {
  /**
   * Test variables
   */
  const decimals = Math.pow(10, 6);
  const token = await TokenMint.init(connection, feePayer);
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const uri = crypto.randomBytes(10).toString();
  const mintAmount = 20 * decimals;

  // Expected balances
  const bobExpectedBalance = { sol: 0, token: 0 };
  const aliceExpectedBalance = { sol: 0, token: 0 };

  /**
   * Create token ATA for Alice and Bob
   */

  const aliceTokenAtaKey = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    token.token.publicKey,
    alice.publicKey
  );
  const bobTokenAtaKey = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    token.token.publicKey,
    bob.publicKey
  );
  let ix = [
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.token.publicKey,
      aliceTokenAtaKey,
      alice.publicKey,
      feePayer.publicKey
    ),
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.token.publicKey,
      bobTokenAtaKey,
      bob.publicKey,
      feePayer.publicKey
    ),
  ];
  let tx = await signAndSendTransactionInstructions(
    connection,
    [],
    feePayer,
    ix
  );

  /**
   * Create domain name
   */
  const size = 100 + 96;
  const lamports = await connection.getMinimumBalanceForRentExemption(size);
  const name = crypto.randomBytes(10).toString();
  const hashedName = await getHashedName(name);
  const nameKey = await getNameAccountKey(hashedName);
  ix = [
    await createNameRegistry(
      connection,
      name,
      size,
      feePayer.publicKey,
      alice.publicKey,
      lamports
    ),
  ];
  tx = await signAndSendTransactionInstructions(connection, [], feePayer, ix);
  console.log(`Create domain tx ${tx}`);

  /**
   * (1) Create central state
   */
  ix = await createCentralState(feePayer.publicKey, programId);
  tx = await signAndSendTransactionInstructions(connection, [], feePayer, ix);

  console.log(`Create centrale state tx ${tx}`);

  /**
   * Verify state
   */
  await sleep(30_000);
  const [centralKey] = await PublicKey.findProgramAddress(
    [programId.toBuffer()],
    programId
  );
  let centralState = await CentralState.retrieve(connection, centralKey);
  expect(centralState.tag).toBe(Tag.CentralState);

  /**
   * (2) Create mint
   */
  const [mintKey] = await PublicKey.findProgramAddress(
    [MINT_PREFIX, nameKey.toBuffer()],
    programId
  );
  ix = await createMint(nameKey, feePayer.publicKey, programId);
  tx = await signAndSendTransactionInstructions(connection, [], feePayer, ix);

  console.log(`Create mint ${tx}`);

  /**
   * Create ATAs for Alice and Bob
   */
  const aliceNftAtaKey = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintKey,
    alice.publicKey
  );
  const bobNftAtaKey = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintKey,
    bob.publicKey
  );

  ix = [
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintKey,
      aliceNftAtaKey,
      alice.publicKey,
      feePayer.publicKey
    ),
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintKey,
      bobNftAtaKey,
      bob.publicKey,
      feePayer.publicKey
    ),
  ];
  tx = await signAndSendTransactionInstructions(connection, [], feePayer, ix);

  console.log(`Create Alice and Bob ATAs`);

  /**
   * Verify state
   */
  await sleep(30_000);
  const mintToken = new Token(connection, mintKey, TOKEN_PROGRAM_ID, feePayer);
  let mintInfo = await mintToken.getMintInfo();
  expect(mintInfo.decimals).toBe(0);
  expect(mintInfo.freezeAuthority.toBase58()).toBe(centralKey.toBase58());
  expect(mintInfo.isInitialized).toBe(true);
  expect(mintInfo.mintAuthority.toBase58()).toBe(centralKey.toBase58());
  expect(mintInfo.supply.toNumber()).toBe(0);

  /**
   * (3) Create NFT
   */
  ix = await createNft(name, uri, nameKey, alice.publicKey, programId);
  tx = await signAndSendTransactionInstructions(
    connection,
    [alice],
    feePayer,
    ix
  );

  console.log(`Create NFT tx ${tx}`);

  /**
   * Verify state
   */
  await sleep(30_000);
  mintInfo = await mintToken.getMintInfo();
  expect(mintInfo.supply.toNumber()).toBe(1);

  const [nftRecordKey, nftRecordNonce] = await NftRecord.findKey(
    nameKey,
    programId
  );
  let nftRecord = await NftRecord.retrieve(connection, nftRecordKey);
  expect(nftRecord.nameAccount.toBase58()).toBe(nameKey.toBase58());
  expect(nftRecord.nftMint.toBase58()).toBe(mintKey.toBase58());
  expect(nftRecord.nonce).toBe(nftRecordNonce);
  expect(nftRecord.owner.toBase58()).toBe(alice.publicKey.toBase58());
  expect(nftRecord.tag).toBe(Tag.ActiveRecord);

  let aliceNftAta = await connection.getTokenAccountBalance(aliceNftAtaKey);
  expect(aliceNftAta.value.uiAmount).toBe(1);

  /**
   * (4) Send funds to the tokenized domain (tokens + SOL)
   */
  const nftRecordTokenAtaKey = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    token.token.publicKey,
    nftRecordKey,
    true
  );
  ix = [
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.token.publicKey,
      nftRecordTokenAtaKey,
      nftRecordKey,
      feePayer.publicKey
    ),
  ];
  await signAndSendTransactionInstructions(connection, [alice], feePayer, ix);
  await token.mintInto(aliceTokenAtaKey, mintAmount);
  await connection.requestAirdrop(nftRecordKey, LAMPORTS_PER_SOL / 2);

  aliceExpectedBalance.sol += LAMPORTS_PER_SOL / 2;
  aliceExpectedBalance.token += mintAmount;

  /**
   * (5) Withdraw funds
   */
  ix = await withdrawTokens(
    connection,
    mintKey,
    alice.publicKey,
    nftRecordKey,
    programId
  );
  tx = await signAndSendTransactionInstructions(
    connection,
    [alice],
    feePayer,
    ix
  );
  console.log(`Alice withdrew tokens ${tx}`);

  /**
   * Verify state
   */
  let fetchedSolBalance = await connection.getBalance(alice.publicKey);
  let fetchedTokenBalance = await connection.getTokenAccountBalance(
    aliceTokenAtaKey
  );

  expect(aliceExpectedBalance.sol).toBe(fetchedSolBalance);
  expect(aliceExpectedBalance.token).toBe(fetchedTokenBalance.value.amount);

  /**
   * (6) Transfer NFT to new wallet
   */
  ix = [
    Token.createTransferInstruction(
      TOKEN_PROGRAM_ID,
      aliceNftAtaKey,
      bobNftAtaKey,
      alice.publicKey,
      [],
      1
    ),
  ];
  tx = await signAndSendTransactionInstructions(
    connection,
    [alice],
    feePayer,
    ix
  );
  console.log(`Transfer NFT from Alice to Bob`);

  /**
   * (7) Send funds to the tokenized domain (tokens + SOL)
   */
  ix = [
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.token.publicKey,
      nftRecordTokenAtaKey,
      nftRecordKey,
      feePayer.publicKey
    ),
  ];
  await signAndSendTransactionInstructions(connection, [alice], feePayer, ix);
  await token.mintInto(aliceTokenAtaKey, mintAmount);
  await connection.requestAirdrop(nftRecordKey, LAMPORTS_PER_SOL / 2);

  bobExpectedBalance.sol += LAMPORTS_PER_SOL / 2;
  bobExpectedBalance.token += mintAmount;

  /**
   * (8) Withdraw funds
   */
  ix = await withdrawTokens(
    connection,
    mintKey,
    bob.publicKey,
    nftRecordKey,
    programId
  );
  tx = await signAndSendTransactionInstructions(
    connection,
    [bob],
    feePayer,
    ix
  );
  console.log(`Bob withdrew tokens ${tx}`);

  /**
   * Verify state
   */
  fetchedSolBalance = await connection.getBalance(bob.publicKey);
  fetchedTokenBalance = await connection.getTokenAccountBalance(bobTokenAtaKey);

  expect(bobExpectedBalance.sol).toBe(fetchedSolBalance);
  expect(bobExpectedBalance.token).toBe(fetchedTokenBalance.value.amount);

  /**
   * (9) Sends funds to the tokenized domain (tokens + SOL)
   */
  ix = [
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token.token.publicKey,
      nftRecordTokenAtaKey,
      nftRecordKey,
      feePayer.publicKey
    ),
  ];
  await signAndSendTransactionInstructions(connection, [alice], feePayer, ix);
  await token.mintInto(aliceTokenAtaKey, mintAmount);
  await connection.requestAirdrop(nftRecordKey, LAMPORTS_PER_SOL / 2);

  bobExpectedBalance.sol += LAMPORTS_PER_SOL / 2;
  bobExpectedBalance.token += mintAmount;

  /**
   * (10) Redeem NFT
   */
  ix = await redeemNft(nameKey, bob.publicKey, programId);
  tx = await signAndSendTransactionInstructions(
    connection,
    [bob],
    feePayer,
    ix
  );
  console.log(`Bob redeemed NFT ${tx}`);

  /**
   * Verify state
   */
  await sleep(30_000);
  mintInfo = await mintToken.getMintInfo();
  expect(mintInfo.supply.toNumber()).toBe(0);

  nftRecord = await NftRecord.retrieve(connection, nftRecordKey);
  expect(nftRecord.nameAccount.toBase58()).toBe(nameKey.toBase58());
  expect(nftRecord.nftMint.toBase58()).toBe(mintKey.toBase58());
  expect(nftRecord.nonce).toBe(nftRecordNonce);
  expect(nftRecord.owner.toBase58()).toBe(bob.publicKey.toBase58());
  expect(nftRecord.tag).toBe(Tag.InactiveRecord);

  /**
   * (11) Withdraw funds
   */
  ix = await withdrawTokens(
    connection,
    mintKey,
    bob.publicKey,
    nftRecordKey,
    programId
  );
  tx = await signAndSendTransactionInstructions(
    connection,
    [bob],
    feePayer,
    ix
  );
  console.log(`Bob withdrew tokens ${tx}`);

  /**
   * Verify state
   */
  await sleep(30_000);
  fetchedSolBalance = await connection.getBalance(bob.publicKey);
  fetchedTokenBalance = await connection.getTokenAccountBalance(bobTokenAtaKey);

  expect(bobExpectedBalance.sol).toBe(fetchedSolBalance);
  expect(bobExpectedBalance.token).toBe(fetchedTokenBalance.value.amount);

  /**
   * (12) Create NFT again
   */
  ix = await createNft(name, uri, nameKey, bob.publicKey, programId);
  tx = await signAndSendTransactionInstructions(
    connection,
    [bob],
    feePayer,
    ix
  );

  /**
   * Verify state
   */
  await sleep(30_000);
  mintInfo = await mintToken.getMintInfo();
  expect(mintInfo.decimals).toBe(0);
  expect(mintInfo.freezeAuthority.toBase58()).toBe(centralKey.toBase58());
  expect(mintInfo.isInitialized).toBe(true);
  expect(mintInfo.mintAuthority.toBase58()).toBe(centralKey.toBase58());
  expect(mintInfo.supply.toNumber()).toBe(0);

  nftRecord = await NftRecord.retrieve(connection, nftRecordKey);
  expect(nftRecord.nameAccount.toBase58()).toBe(nameKey.toBase58());
  expect(nftRecord.nftMint.toBase58()).toBe(mintKey.toBase58());
  expect(nftRecord.nonce).toBe(nftRecordNonce);
  expect(nftRecord.owner.toBase58()).toBe(bob.publicKey.toBase58());
  expect(nftRecord.tag).toBe(Tag.ActiveRecord);

  /**
   * (13) Verify metadata
   */
  const metadata = await Metadata.findByMint(connection, mintKey);

  expect(metadata.data.data.name).toBe(name);
  expect(metadata.data.data.sellerFeeBasisPoints).toBe(500);
  expect(metadata.data.data.symbol).toBe(".sol");
  expect(metadata.data.data.uri).toBe(uri);
  expect(metadata.data.isMutable).toBe(true);
  expect(metadata.data.mint).toBe(mintKey.toBase58());
  expect(metadata.data.updateAuthority).toBe(centralKey.toBase58());

  expect(metadata.data.data.creators.toString()).toBe("");
});
