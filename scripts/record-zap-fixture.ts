// Records one aggregator quote (0.1 WETH to USDC, 50 bps, zap contract as executor)
// into test/fixtures/<aggregator>-<chain>-<amount-from>-weth-to-usdc-<block>.json.
// Usage: node scripts/record-zap-fixture.ts <kyberswap|velora> <ethereum|base>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";

const root = join(import.meta.dirname, "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CHAINS = {
  ethereum: {
    id: 1,
    rpcEnv: "RPC_URL_MAINNET",
    zap: "0x677251190C0cCcC6E7e71C385B3EA660Dfd89c00",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  base: {
    id: 8453,
    rpcEnv: "RPC_URL_BASE",
    zap: "0xEbCf47837ad71Fc98d5B608356eaC1FF38fa67DB",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
  },
} as const;

const AMOUNT_IN = 100000000000000000n; // 0.1 WETH
const SLIPPAGE_BPS = 50;
const FAR_DEADLINE = 4102444800; // 2100-01-01
const VELORA_VERSION = "6.2";

const [aggregator, chainName] = process.argv.slice(2);
if ((aggregator !== "kyberswap" && aggregator !== "velora") || (chainName !== "ethereum" && chainName !== "base")) {
  throw new Error("Usage: node scripts/record-zap-fixture.ts <kyberswap|velora> <ethereum|base>");
}
const chain = CHAINS[chainName];

const readJsonResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`${response.status} ${response.url}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
};
const postJson = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    readJsonResponse,
  );

// Reads a dotted path from a response body, throwing an error that names the missing field.
const readField = (source: unknown, path: string): unknown => {
  let value = source;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      throw new Error(`Aggregator response is missing "${path}"`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};
const readString = (source: unknown, path: string): string => {
  const value = readField(source, path);
  if (typeof value !== "string") throw new Error(`Aggregator response field "${path}" is not a string`);
  return value;
};
const readNumber = (source: unknown, path: string): number => {
  const value = readField(source, path);
  if (typeof value !== "number") throw new Error(`Aggregator response field "${path}" is not a number`);
  return value;
};

const rpcUrl = process.env[chain.rpcEnv];
if (!rpcUrl) throw new Error(`${chain.rpcEnv} is not set in .env`);
const headBlock = async () =>
  parseInt(
    readString(await postJson(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), "result"),
    16,
  );

let block: number, quotedOut: bigint, target: string, approvalProxy: string, calldata: string;

if (aggregator === "kyberswap") {
  const base = `https://aggregator-api.kyberswap.com/${chainName}/api/v1`;
  block = await headBlock(); // the routes response carries no block number
  const route = await readJsonResponse(
    await fetch(`${base}/routes?${new URLSearchParams({ tokenIn: chain.weth, tokenOut: chain.usdc, amountIn: AMOUNT_IN.toString() })}`),
  );
  const routeSummary = readField(route, "data.routeSummary");
  const build = await postJson(`${base}/route/build`, {
    routeSummary,
    sender: chain.zap,
    recipient: chain.zap,
    slippageTolerance: SLIPPAGE_BPS,
    deadline: FAR_DEADLINE,
  });
  quotedOut = BigInt(readString(routeSummary, "amountOut"));
  target = approvalProxy = readString(build, "data.routerAddress");
  calldata = readString(build, "data.data");
} else {
  const prices = await readJsonResponse(
    await fetch(
      `https://api.velora.xyz/prices?${new URLSearchParams({
        srcToken: chain.weth,
        destToken: chain.usdc,
        network: String(chain.id),
        version: VELORA_VERSION,
        srcDecimals: "18",
        destDecimals: "6",
        amount: AMOUNT_IN.toString(),
        userAddress: chain.zap,
        side: "SELL",
      })}`,
    ),
  );
  const priceRoute = readField(prices, "priceRoute");
  block = readNumber(priceRoute, "blockNumber");
  const transaction = await postJson(`https://api.velora.xyz/transactions/${chain.id}?ignoreChecks=true`, {
    srcToken: chain.weth,
    destToken: chain.usdc,
    srcDecimals: 18,
    destDecimals: 6,
    userAddress: chain.zap,
    priceRoute,
    srcAmount: AMOUNT_IN.toString(),
    slippage: SLIPPAGE_BPS,
    deadline: FAR_DEADLINE,
  });
  quotedOut = BigInt(readString(priceRoute, "destAmount"));
  target = readString(transaction, "to");
  approvalProxy = readString(priceRoute, "tokenTransferProxy");
  calldata = readString(transaction, "data");
}

const fixture = {
  aggregator,
  chain: chainName,
  block,
  pair: { tokenIn: chain.weth, tokenOut: chain.usdc },
  amountIn: AMOUNT_IN.toString(),
  quotedOut: quotedOut.toString(),
  minOut: ((quotedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n).toString(),
  router: { target, approvalProxy },
  calldata,
};

const dir = join(root, "test", "fixtures");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${aggregator}-${chainName}-${formatEther(AMOUNT_IN)}-weth-to-usdc-${block}.json`);
writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
console.log(`${file} block ${block}`);
