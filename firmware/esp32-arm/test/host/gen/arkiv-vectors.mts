/**
 * Builds Arkiv create-entity test vectors with @arkiv-network/sdk@1.0.1, WITHOUT touching a network.
 * A custom viem transport answers every JSON-RPC call with fake data and captures what the SDK sends
 * (eth_estimateGas params, eth_sendRawTransaction raw tx). Nothing leaves this process.
 *
 * Run:  cd "/Users/divyabanda/ethglobal mumbai divya/apps/backend" && npx tsx <this file>
 */
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const BACKEND = "/Users/divyabanda/ethglobal mumbai divya/apps/backend/package.json"
const OUT = dirname(new URL(import.meta.url).pathname)
const req = createRequire(BACKEND)
const sdkDir = dirname(req.resolve("@arkiv-network/sdk/package.json"))
const sdkReq = createRequire(join(sdkDir, "package.json"))
const imp = (p: string) => import(pathToFileURL(p).href)

const sdk = await imp(join(sdkDir, "dist/index.js"))
const chains = await imp(join(sdkDir, "dist/chains/index.js"))
const schemaMod = await imp(join(sdkDir, "dist/schema/index.js"))
const viem = await imp(sdkReq.resolve("viem").replace(/_cjs/, "_esm").replace(/index\.js$/, "index.js"))
const accounts = await imp(sdkReq.resolve("viem/accounts").replace(/_cjs/, "_esm"))
// internal encoders, straight from the SDK's TypeScript source (tsx transpiles them)
const ops = await imp(join(sdkDir, "src/entity/operations.ts"))
const attrs = await imp(join(sdkDir, "src/schema/attributes.ts"))
const keyMod = await imp(join(sdkDir, "src/entity/key.ts"))
const consts = await imp(join(sdkDir, "src/consts.ts"))

const { createWalletClient, ExpirationTime } = sdk
const { rabdi } = chains
const { defineSchema, str, u64, i32 } = schemaMod
const { custom, keccak256, parseTransaction, recoverTransactionAddress, toHex, encodeEventTopics, decodeFunctionData, toFunctionSelector, serializeTransaction } = viem
const { privateKeyToAccount } = accounts

// ---- fixed inputs -------------------------------------------------------------------------------
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // anvil/hardhat test key #0, NOT a real key
const account = privateKeyToAccount(PRIVATE_KEY)
const FAKE = {
  blockNumber: 0x43641n, // a real recent Rabdi height (276033), only used to resolve expiry
  baseFeePerGas: 0x3b9aca00n, // 1 gwei: what Rabdi reported on 6 Nov 2026
  maxPriorityFeePerGas: 0n, // Rabdi eth_maxPriorityFeePerGas = 0x0
  accountNonce: 7, // eth_getTransactionCount answer
  estimateGas: 168515n, // previously measured on Rabdi for this shape
  entityNonce: 0n, // engine's per-owner entity nonce (for predicted key in the fake receipt)
}
const SALT = 0x000102030405060708090a0b0c0d0e0fn // fixed for reproducibility; the SDK default is 16 random bytes

const EpisodeIndex = defineSchema("pearl.episode.v2", {
  kind: str().indexed(),
  armId: str().indexed(),
  episodeId: str().indexed(),
  outcome: str().indexed(),
  ts: u64().indexed(),
  severity: i32().indexed(),
  headHash: str(),
  rootHash: str().optional(),
  storageTx: str().optional(),
  anchorTx: str().optional(),
})
const values = {
  kind: "incident",
  armId: "arm-1",
  episodeId: "ep_20261106052200_b7e2",
  outcome: "TRIPPED",
  ts: u64(1762406520000n),
  severity: 3,
  headHash: "ab".repeat(32),
  rootHash: "0x" + "cd".repeat(32),
  storageTx: "0x" + "ef".repeat(32),
  anchorTx: undefined,
}

// ---- fake transport -----------------------------------------------------------------------------
const calls: { method: string; params: unknown }[] = []
let rawTx: `0x${string}` | undefined
let estimateParams: unknown
const CHAIN_ID = 7794095
const predictedKey = keyMod.predictEntityKey({ owner: account.address, nonce: FAKE.entityNonce, salt: SALT, chainId: CHAIN_ID })
const createdTopics = encodeEventTopics({
  abi: (await imp(join(sdkDir, "src/entity/events.ts"))).ENTITY_EVENTS_ABI,
  eventName: "EntityCreated",
  args: { entityKey: predictedKey, owner: account.address },
})
const fakeBlock = (n: bigint) => ({
  number: toHex(n), hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), timestamp: "0x6aed51a4",
  baseFeePerGas: toHex(FAKE.baseFeePerGas), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [],
  logsBloom: "0x" + "00".repeat(256), miner: "0x000000000000000000000000000000000000dead", difficulty: "0x0",
  extraData: "0x", nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32),
  receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), mixHash: "0x" + "00".repeat(32), size: "0x0",
})
const transport = custom({
  async request({ method, params }: { method: string; params: any }) {
    calls.push({ method, params })
    switch (method) {
      case "eth_chainId": return toHex(CHAIN_ID)
      case "eth_blockNumber": return toHex(FAKE.blockNumber)
      case "eth_getBlockByNumber": return fakeBlock(FAKE.blockNumber)
      case "eth_maxPriorityFeePerGas": return toHex(FAKE.maxPriorityFeePerGas)
      case "eth_gasPrice": return toHex(FAKE.baseFeePerGas)
      case "eth_getTransactionCount": return toHex(FAKE.accountNonce)
      case "eth_estimateGas": estimateParams = params; return toHex(FAKE.estimateGas)
      case "eth_sendRawTransaction": rawTx = params[0]; return keccak256(params[0])
      case "eth_getTransactionReceipt": {
        const h = keccak256(rawTx!)
        const expiresAt = FAKE.blockNumber + 1n + 1296000n
        return {
          transactionHash: h, transactionIndex: "0x0", blockHash: "0x" + "33".repeat(32), blockNumber: toHex(FAKE.blockNumber + 1n),
          from: account.address.toLowerCase(), to: consts.ARKIV_ADDRESS, cumulativeGasUsed: toHex(FAKE.estimateGas),
          gasUsed: toHex(FAKE.estimateGas), effectiveGasPrice: toHex(FAKE.baseFeePerGas), contractAddress: null,
          logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2",
          logs: [{
            address: consts.ARKIV_ADDRESS, topics: createdTopics,
            // data = abi.encode(uint64 expiresAt, uint8 creationFlags)
            data: "0x" + expiresAt.toString(16).padStart(64, "0") + "01".padStart(64, "0"),
            blockNumber: toHex(FAKE.blockNumber + 1n), transactionHash: h, transactionIndex: "0x0",
            blockHash: "0x" + "33".repeat(32), logIndex: "0x0", removed: false,
          }],
        }
      }
      case "eth_getTransactionByHash": return null
      default: throw new Error("unexpected RPC " + method)
    }
  },
})

const wallet = createWalletClient({ chain: rabdi({ accessKey: "TESTKEY" }), transport, account, pollingInterval: 10 })
const result = await wallet.createEntity(EpisodeIndex, values, {
  expiration: ExpirationTime.fromDays(30),
  flags: { readonly: true },
  salt: SALT,
})

// ---- analyse what was captured ------------------------------------------------------------------
const tx = parseTransaction(rawTx!)
const from = await recoverTransactionAddress({ serializedTransaction: rawTx! })
const unsigned = serializeTransaction({ ...tx, r: undefined, s: undefined, v: undefined, yParity: undefined })
const calldata = tx.data as `0x${string}`
const decoded = decodeFunctionData({ abi: ops.EXECUTE_ABI, data: calldata })
const opData = decoded.args[0][0].operationData as `0x${string}`

// cross-check with the SDK's internal encoders directly
const attributes = attrs.encodeCreate(EpisodeIndex, values)
const directOp = ops.createOperation({ salt: SALT, expiry: { expiresAt: 0n, minLifetime: 1296000n }, creationFlags: 1, attributes })
if (directOp.operationData !== opData) throw new Error("internal encoder disagrees with captured calldata")

// independent hand-rolled encoder, mirroring what the firmware should do
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const word = (n: bigint) => n.toString(16).padStart(64, "0")
const padRight = (h: string) => h + "0".repeat((64 - (h.length % 64)) % 64)
function encBytes(h: string) { return word(BigInt(h.length / 2)) + padRight(h) }
function handEncode(): string {
  // attribute tuples (bytes32 name, uint8 typeId, bytes value): dynamic tuple → head 3 words + tail
  const encAttr = (a: { name: string; typeId: number; value: string }) =>
    a.name.slice(2) + word(BigInt(a.typeId)) + word(96n) + encBytes(a.value.slice(2))
  const attrBlobs = attributes.map(encAttr)
  // array of dynamic tuples: length, then N offsets (relative to start of the offsets area), then blobs
  let arr = word(BigInt(attrBlobs.length))
  let off = BigInt(attrBlobs.length * 32)
  for (const b of attrBlobs) { arr += word(off); off += BigInt(b.length / 2) }
  arr += attrBlobs.join("")
  // create payload = abi.encode((uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 flags, attrs[]))
  // single dynamic tuple param → word(0x20) then tuple body (5 head words; attrs offset = 0xa0)
  const createPayload = word(32n) + word(SALT) + word(0n) + word(1296000n) + word(1n) + word(160n) + arr
  // execute((uint8,bytes)[]): selector, offset 0x20, len 1, offset 0x20 to tuple, tuple: op=1, offset 0x40, bytes
  const opTuple = word(1n) + word(64n) + encBytes(createPayload)
  return "0x" + toFunctionSelector("function execute((uint8,bytes)[])").slice(2) + word(32n) + word(1n) + word(32n) + opTuple
}
const hand = handEncode()
if (hand !== calldata) throw new Error("hand encoder disagrees with captured calldata")

const words = (h: string) => (h.replace(/^0x/, "").match(/.{1,64}/g) ?? [])
const vectors = {
  generatedBy: "make-vectors.ts with @arkiv-network/sdk@1.0.1 + viem 2.57.14, fake transport, nothing sent",
  inputs: {
    schema: "pearl.episode.v2",
    values: { ...values, ts: "1762406520000 (u64)", severity: "3 (i32)", anchorTx: "(omitted)" },
    expiration: "ExpirationTime.fromDays(30)", flags: { readonly: true },
    salt: toHex(SALT, { size: 16 }), saltNote: "SDK default is randomSalt(): 16 bytes from crypto.getRandomValues; fixed here so the vector is reproducible",
    privateKey: PRIVATE_KEY, privateKeyNote: "public anvil/hardhat test key #0",
    from: account.address,
    fakeChainAnswers: { ...Object.fromEntries(Object.entries(FAKE).map(([k, v]) => [k, String(v)])) },
  },
  selector: toFunctionSelector("function execute((uint8 operation, bytes operationData)[] ops)"),
  eventTopic0_EntityCreated: createdTopics[0],
  to: tx.to,
  chainId: tx.chainId,
  value: String(tx.value ?? 0n),
  attributes: attributes.map((a: any) => ({ nameAscii: Buffer.from(a.name.slice(2), "hex").toString().replace(/\0+$/, ""), name: a.name, typeId: "0x" + a.typeId.toString(16).padStart(2, "0"), value: a.value })),
  createOperationData: opData,
  createOperationDataWords: words(opData),
  calldata,
  calldataLength: (calldata.length - 2) / 2,
  calldataWords: [calldata.slice(0, 10), ...words(calldata.slice(10))],
  rpcSequence: calls.map((c) => c.method),
  eth_estimateGas_params: estimateParams,
  tx: {
    type: tx.type, chainId: tx.chainId, nonce: tx.nonce, maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas),
    maxFeePerGas: String(tx.maxFeePerGas), gas: String(tx.gas), to: tx.to, value: String(tx.value ?? 0n),
    accessList: tx.accessList, yParity: tx.yParity, r: tx.r, s: tx.s,
  },
  unsignedTxForSigning: unsigned,
  signingHash: keccak256(unsigned),
  signedRawTx: rawTx,
  txHash: keccak256(rawTx!),
  recoveredFrom: from,
  predictedEntityKey: predictedKey,
  predictedEntityKeyInputs: { packed: "uint256 chainId ++ address 0x44..44 ++ address owner ++ uint64 entityNonce ++ uint128 salt", entityNonce: String(FAKE.entityNonce) },
  sdkResult: { entityKey: result.entityKey, txHash: result.txHash, expiresAt: String(result.expiresAt) },
}
writeFileSync(join(OUT, "vectors.json"), JSON.stringify(vectors, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2))
console.log(JSON.stringify({ calldataLength: vectors.calldataLength, rpc: vectors.rpcSequence, tx: vectors.tx, txHash: vectors.txHash, key: result.entityKey, from }, null, 1))
console.log("hand encoder == SDK calldata; internal createOperation == captured")
