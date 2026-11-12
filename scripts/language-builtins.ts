// docs/language-builtins.md: every name lib/typesol.d.ts exports, grouped, with its declaration and the first sentence
// of its own doc comment, and a link to the part of the language guide that explains it.
//   node scripts/language-builtins.ts          write it
//   node scripts/language-builtins.ts --check  fail when it is out of date (test/cli/ai.test.ts runs this)
// Both fail when an export has no doc comment or belongs to no group below, when a group names something the file does
// not export, or when a group's link does not land on a heading of the guide.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = "lib/typesol.d.ts";
const OUT = "docs/language-builtins.md";

/** The groups, in page order: [heading, link into the guide, names]. */
const GROUPS: [string, string, string[]][] = [
  [
    "Integers and numbers",
    "language-types.md#integers",
    [
      "u8",
      "u16",
      "u32",
      "u64",
      "u128",
      "u256",
      "i8",
      "i16",
      "i32",
      "i64",
      "i128",
      "mulDiv",
      "mulDivCeil",
      "isqrt",
      "min",
      "max",
      "f64",
      "f64FromBits",
      "f64Bits",
    ],
  ],
  ["Addresses, hashes, strings and options", "language-types.md#pubkey-and-hash", ["Pubkey", "Hash", "pubkey", "FixedString", "byteLength", "Option"]],
  ["Lists", "language-types.md#lists", ["ListMethods", "FixedArray", "fixedArray", "FixedVec", "fixedVec", "Vec", "IndexedList"]],
  ["Helpers", "language-statements.md#inout-parameters", ["Inout"]],
  [
    "Account types",
    "language-accounts.md#account-parameters-and-the-checks-they-emit",
    [
      "AccountMeta",
      "Signer",
      "SystemAccount",
      "AccountInfo",
      "Account",
      "Mut",
      "Init",
      "InitIfNeeded",
      "Zeroed",
      "Migrate",
      "Dup",
      "Optional",
      "ProgramData",
      "Program",
      "UncheckedProgram",
      "SystemProgram",
      "EventAuthority",
      "SelfProgram",
    ],
  ],
  ["Constraints", "language-accounts.md#constraints", ["HasOne", "Seeds", "CloseTo", "Address", "Owner", "Executable", "Signed", "constraint"]],
  ["Closing and resizing", "language-accounts.md#closing-and-resizing", ["close", "realloc", "resizeAccount"]],
  ["Accounts created by hand", "language-accounts.md#accounts-created-by-hand", ["initAccount"]],
  [
    "Remaining accounts and other programs' accounts",
    "language-accounts.md#remaining-accounts",
    ["remainingAccounts", "RemainingAccount", "RemainingAccounts", "RemainingSlice", "loadAccount", "loadAccountMut", "loadForeign", "readData", "writeData"],
  ],
  [
    "PDAs",
    "language-pdas.md",
    [
      "Seed",
      "SignerSeeds",
      "signer",
      "requirePda",
      "bigEndian",
      "findProgramAddress",
      "findProgramAddressBump",
      "findProgramAddressWithBump",
      "createProgramAddress",
      "programId",
    ],
  ],
  ["Errors", "language-errors-events.md#require", ["require", "AnchorError", "ProgramError"]],
  ["Logs, events and return values", "language-errors-events.md#events", ["log", "emit", "emitCpi"]],
  [
    "Calling other programs",
    "language-cpi.md#invoke",
    [
      "invoke",
      "CpiAccount",
      "readonly",
      "writable",
      "readonlySigner",
      "writableSigner",
      "CpiData",
      "Bytes",
      "sighash",
      "hex",
      "returnData",
      "invokeInstruction",
      "InstructionAccountMeta",
      "programAt",
      "sysvarAt",
      "named",
      "NamedAccount",
    ],
  ],
  [
    "Tokens",
    "language-cpi.md#tokens",
    [
      "TokenAccount",
      "Mint",
      "TokenProgram",
      "Token2022Program",
      "TokenInterface",
      "TokenOf",
      "MintOf",
      "Ata",
      "MintExtensions",
      "AuthorityType",
      "AssociatedTokenProgram",
      "associatedTokenAddress",
      "rentExempt",
      "TOKEN_ACCOUNT_SIZE",
      "MINT_SIZE",
    ],
  ],
  [
    "Token-2022 extension reads",
    "language-cpi.md#token-2022-extension-reads",
    [
      "transferFee",
      "transferFeeInverse",
      "transferFeeBasisPoints",
      "transferFeeMaximum",
      "extensionsWithin",
      "hasExtension",
      "transferHookProgram",
      "transferHookAuthority",
      "permanentDelegate",
      "mintCloseAuthority",
      "isTransferring",
    ],
  ],
  [
    "Transfer hooks",
    "language-cpi.md#implementing-another-programs-interface-transfer-hooks",
    ["initExtraAccountMetas", "updateExtraAccountMetas", "ExtraAccountMeta", "ExtraAccountSeed", "seedAccountKey", "seedAccountData", "seedInstructionData"],
  ],
  [
    "Memo, Token Metadata and Stake",
    "language-cpi.md#associated-token-memo-metadata-and-stake",
    ["MemoProgram", "TokenMetadataProgram", "MetadataCreator", "metadataAddress", "masterEditionAddress", "StakeProgram"],
  ],
  [
    "Metaplex Core",
    "language-cpi.md#metaplex-core",
    [
      "MplCoreProgram",
      "CorePlugin",
      "CorePluginKind",
      "CorePluginAuthority",
      "CoreExternalPlugin",
      "CoreExternalPluginKey",
      "CoreLifecycleCheck",
      "CoreExtraAccount",
      "coreAssetOwner",
      "coreAssetCollection",
    ],
  ],
  [
    "Compressed NFTs",
    "language-cpi.md#compressed-nfts-bubblegum",
    ["BubblegumProgram", "CompressedLeaf", "CompressedLeafRef", "CompressedLeafV1", "CompressedMetadata", "CompressedMetadataV2", "CompressedMetadataUpdate"],
  ],
  [
    "Sysvars",
    "language-chain.md#sysvars",
    [
      "now",
      "currentSlot",
      "currentEpoch",
      "epochStartTimestamp",
      "slotsPerEpoch",
      "epochWarmup",
      "firstNormalEpoch",
      "firstNormalSlot",
      "lastRestartSlot",
      "epochRewards",
      "EpochRewards",
      "minimumBalance",
      "SlotHashesSysvar",
      "StakeHistorySysvar",
      "stackHeight",
    ],
  ],
  [
    "Hashes, signatures and introspection",
    "language-chain.md#hashing",
    ["sha256", "keccak256", "merkleVerify", "verifyEd25519", "verifySecp256k1", "ethMessageHash", "InstructionsSysvar", "TransactionInstruction"],
  ],
  ["Oracles and randomness", "language-chain.md#oracles", ["PythPriceUpdate", "pythPrice", "SwitchboardFeed", "switchboardValue", "SwitchboardRandomness"]],
  [
    "Native programs",
    "language-native.md",
    [
      "instructionData",
      "InstructionBytes",
      "loadRaw",
      "loadRawMut",
      "loadBorsh",
      "storeBorsh",
      "BigVec",
      "BigVecSlice",
      "loadRawAt",
      "loadRawMutAt",
      "rawArrayAt",
      "rawArrayMutAt",
      "RawArray",
      "ReadonlyRawArray",
      "rbTreeAt",
      "rbTreeMutAt",
      "RedBlackTree",
      "ReadonlyRedBlackTree",
      "RbEntry",
      "closeRaw",
      "assignOwner",
      "setReturnData",
      "panic",
      "panicsAt",
      "abort",
      "logBase64",
      "logComputeUnits",
    ],
  ],
];

interface Export {
  name: string;
  /** Each declaration's short form: overloads and a type with a cast of the same name are listed together. */
  forms: string[];
  doc: string;
}

/** The doc comment nearest the declaration (a file's header comment above the first one is not its own). */
function ownDoc(node: ts.Node): string {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const last = docs.at(-1);
  return last ? (ts.getTextOfJSDocComment(last.comment) ?? "") : "";
}

const flat = (s: string) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/,\)/g, ")").trim();

function shortForm(st: ts.Statement, sf: ts.SourceFile): string {
  const text = (n: ts.Node | undefined) => (n ? n.getText(sf) : "");
  const tparams = (n: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }) =>
    n.typeParameters ? `<${n.typeParameters.map((p) => p.name.text).join(", ")}>` : "";
  if (ts.isFunctionDeclaration(st)) {
    const params = st.parameters
      .map((p) => (p.dotDotDotToken ? "..." : "") + text(p.name) + (p.questionToken ? "?" : "") + (p.type ? `: ${flat(text(p.type))}` : ""))
      .join(", ");
    return `function ${st.name!.text}${tparams(st)}(${params}): ${flat(text(st.type))}`;
  }
  if (ts.isInterfaceDeclaration(st)) return `interface ${st.name.text}${tparams(st)}`;
  if (ts.isTypeAliasDeclaration(st)) {
    const rhs = flat(text(st.type));
    return `type ${st.name.text}${tparams(st)}` + (rhs.length <= 60 ? ` = ${rhs}` : "");
  }
  if (ts.isEnumDeclaration(st)) return `enum ${st.name.text}`;
  if (ts.isVariableStatement(st)) {
    const d = st.declarationList.declarations[0]!;
    const t = flat(text(d.type));
    return `const ${text(d.name)}` + (t.length <= 60 ? `: ${t}` : "");
  }
  throw new Error(`${LIB}: unexpected export ${ts.SyntaxKind[st.kind]}`);
}

export function exportsOf(source: string): Map<string, Export> {
  const sf = ts.createSourceFile(LIB, source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Export>();
  for (const st of sf.statements) {
    if (!(ts.getCombinedModifierFlags(st as unknown as ts.Declaration) & ts.ModifierFlags.Export)) continue;
    const name = ts.isVariableStatement(st) ? st.declarationList.declarations[0]!.name.getText(sf) : (st as ts.DeclarationStatement).name!.getText(sf);
    const e = out.get(name) ?? { name, forms: [], doc: "" };
    const form = shortForm(st, sf);
    if (!e.forms.includes(form)) e.forms.push(form);
    e.doc ||= ownDoc(st);
    out.set(name, e);
  }
  return out;
}

/** The first sentence of a doc comment, on one line, safe in a table cell. */
export function firstSentence(doc: string): string {
  // A doc comment that opens with a list ("Declarative constraints …: - `HasOne<…>`: …") keeps its lead-in.
  const one = doc
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:\s+- [\s\S]*$/, ".");
  const m = /^(.+?[.!?])(?=\s+[A-Z`(]|$)/.exec(one.replace(/\be\.g\./g, "e\u2024g\u2024"));
  return (m ? m[1]! : one).replace(/\u2024/g, ".").replace(/\|/g, "\\|");
}

/** A heading's anchor as GitHub (and the docs site) make it. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A page's headings by anchor ("" for its title). */
export function headings(page: string): Map<string, string> {
  const text = readFileSync(path.join(ROOT, "docs", page), "utf8").replace(/^ *```[\s\S]*?^ *```/gm, "");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^(#{1,6}) (.+)$/gm)) out.set(m[1] === "#" ? "" : slug(m[2]!), m[2]!.replace(/`/g, ""));
  return out;
}

/** "Types: Integers" for language-types.md#integers. */
function linkText(link: string): string {
  const [page, anchor] = link.split("#") as [string, string | undefined];
  const h = headings(page);
  return anchor === undefined ? h.get("")! : `${h.get("")}: ${h.get(anchor)}`;
}

export function builtinsPage(): string {
  const all = exportsOf(readFileSync(path.join(ROOT, LIB), "utf8"));
  const problems: string[] = [];
  const grouped = new Set<string>();
  for (const [heading, link, names] of GROUPS) {
    const [page, anchor] = link.split("#") as [string, string | undefined];
    if (!headings(page).has(anchor ?? "")) problems.push(`${heading}: ${link} is not a heading of docs/${page}`);
    for (const n of names) {
      if (!all.has(n)) problems.push(`${heading}: ${n} is not exported by ${LIB}`);
      if (grouped.has(n)) problems.push(`${n} is in two groups`);
      grouped.add(n);
    }
  }
  for (const e of all.values()) {
    if (!grouped.has(e.name)) problems.push(`${e.name}: add it to a group in scripts/language-builtins.ts`);
    if (!e.doc.trim()) problems.push(`${e.name}: give it a doc comment in ${LIB}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));

  const lines = [
    "# Built-ins",
    "",
    "<!-- Generated by scripts/language-builtins.ts from lib/typesol.d.ts; do not edit by hand. -->",
    "",
    `Every name \`"typesol"\` exports (${all.size} names, ${[...all.values()].reduce((n, e) => n + e.forms.length, 0)} declarations), grouped, with its declaration and the first sentence of its doc`,
    "comment in `lib/typesol.d.ts`. Each group links to the part of the [language guide](language.md) that explains it;",
    "your editor shows the full doc comment on hover. Methods of account and program types (`systemProgram.transfer`,",
    "`acct.create`, …) are described with their types in the guide.",
    "",
    ...GROUPS.map(([heading]) => `- [${heading}](#${slug(heading)})`),
    "",
  ];
  for (const [heading, link, names] of GROUPS) {
    lines.push(`## ${heading}`, "", `Explained in [${linkText(link)}](${link}).`, "", "| Name | Declaration | What it is |", "| --- | --- | --- |");
    for (const n of names) {
      const e = all.get(n)!;
      lines.push(`| \`${n}\` | ${e.forms.map((f) => `\`${f.replace(/\|/g, "\\|")}\``).join("<br>")} | ${firstSentence(e.doc)} |`);
    }
    lines.push("");
  }
  lines.push("**Next:** [Glossary](glossary.md): the Solana and TypeSOL terms the guide uses.", "");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let page: string;
  try {
    page = builtinsPage();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(path.join(ROOT, OUT), "utf8");
    } catch {
      // missing: out of date
    }
    if (current !== page) {
      console.error(`out of date: ${OUT}; run node scripts/language-builtins.ts`);
      process.exit(1);
    }
  } else writeFileSync(path.join(ROOT, OUT), page);
}
