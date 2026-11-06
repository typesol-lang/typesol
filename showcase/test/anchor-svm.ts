// An Anchor client over a LiteSVM ledger: Program.methods(…).accounts(…).instruction() resolves the IDL's PDAs and
// relations by reading the ledger, as it would read a cluster. Only for building instructions (nothing is sent through
// it): the venue tests set up other programs' state with their own instructions this way.
import { type Address, type Instruction, AccountRole, address } from "@solana/kit";
import { AnchorProvider, type Idl, Program, web3 } from "@anchor-lang/core";
import type { LiteSVM } from "litesvm";

/** A read-only Connection over `svm`: account reads, which is all Anchor's account resolution does. */
function connectionOf(svm: LiteSVM): web3.Connection {
  const info = (key: web3.PublicKey) => {
    const a = svm.getAccount(address(key.toBase58()));
    if (!a.exists) return null;
    return {
      data: Buffer.from(a.data),
      executable: a.executable,
      lamports: Number(a.lamports),
      owner: new web3.PublicKey(a.programAddress),
      rentEpoch: 0,
    };
  };
  return {
    getAccountInfo: async (key: web3.PublicKey) => info(key),
    getAccountInfoAndContext: async (key: web3.PublicKey) => ({ context: { slot: 0 }, value: info(key) }),
    getMultipleAccountsInfo: async (keys: web3.PublicKey[]) => keys.map(info),
    getMultipleAccountsInfoAndContext: async (keys: web3.PublicKey[]) => ({ context: { slot: 0 }, value: keys.map(info) }),
  } as unknown as web3.Connection;
}

/** An Anchor Program for `idl` reading `svm`; `payer` fills in the wallet Anchor asks for. */
export function programOn(idl: Idl, svm: LiteSVM, payer: Address): Program {
  const wallet = {
    publicKey: new web3.PublicKey(payer),
    signTransaction: async <T>(t: T) => t,
    signAllTransactions: async <T>(t: T[]) => t,
  };
  return new Program(idl, new AnchorProvider(connectionOf(svm), wallet as never, {}));
}

/** A web3.js instruction as a kit Instruction; `signers` are attached to their accounts by address. */
export function kitIx(ix: web3.TransactionInstruction, signers: { address: Address }[] = []): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const a = address(k.pubkey.toBase58());
      const signer = signers.find((x) => x.address === a);
      return {
        address: a,
        role: k.isSigner
          ? k.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : k.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
        ...(k.isSigner && signer ? { signer } : {}),
      };
    }) as Instruction["accounts"],
    data: new Uint8Array(ix.data),
  };
}
