import { deserialize } from "borsh";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

export const MINT_PREFIX = Buffer.from("tokenized_name");
export const COLLECTION_PREFIX = Buffer.from("collection");

export const METADATA_SIGNER = new PublicKey(
  "Es33LnWSTZ9GbW6yBaRkSLUaFibVd7iS54e4AvBg76LX"
);

export enum Tag {
  Uninitialized = 0,
  CentralState = 1,
  ActiveRecord = 2,
  InactiveRecord = 3,
}

export class NftRecord {
  tag: Tag;
  nonce: number;
  nameAccount: PublicKey;
  owner: PublicKey;
  nftMint: PublicKey;

  static schema = {
    struct: {
      tag: "u8",
      nonce: "u8",
      nameAccount: { array: { type: "u8", len: 32 } },
      owner: { array: { type: "u8", len: 32 } },
      nftMint: { array: { type: "u8", len: 32 } },
    },
  };

  constructor(obj: {
    tag: number;
    nonce: number;
    nameAccount: Uint8Array;
    owner: Uint8Array;
    nftMint: Uint8Array;
  }) {
    this.tag = obj.tag as Tag;
    this.nonce = obj.nonce;
    this.nameAccount = new PublicKey(obj.nameAccount);
    this.owner = new PublicKey(obj.owner);
    this.nftMint = new PublicKey(obj.nftMint);
  }

  static deserialize(data: Buffer): NftRecord {
    return new NftRecord(deserialize(this.schema, data) as any);
  }

  static async retrieve(connection: Connection, key: PublicKey) {
    const accountInfo = await connection.getAccountInfo(key);
    if (!accountInfo || !accountInfo.data) {
      throw new Error("NFT record not found");
    }
    return this.deserialize(accountInfo.data);
  }
  static async findKey(nameAccount: PublicKey, programId: PublicKey) {
    return await PublicKey.findProgramAddress(
      [Buffer.from("nft_record"), nameAccount.toBuffer()],
      programId
    );
  }

  static findKeySync(nameAccount: PublicKey, programId: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nft_record"), nameAccount.toBuffer()],
      programId
    );
  }
}
