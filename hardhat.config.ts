import { existsSync } from "node:fs";
import { join } from "node:path";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

const envFile = join(import.meta.dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  plugins: [hardhatViem, hardhatNetworkHelpers, hardhatNodeTestRunner],
  chainDescriptors: {
    // Without a hardfork history, eth_call at the Base fork block fails.
    8453: { name: "Base", chainType: "op", hardforkHistory: { isthmus: { blockNumber: 0 } } },
  },
  networks: {
    base: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
      initialBaseFeePerGas: 0,
      forking: { url: configVariable("RPC_URL_BASE"), blockNumber: 53290165 },
    },
    // Forked at the block test/fixtures/*-ethereum-*-26330265.json were quoted at.
    ethereum: {
      type: "edr-simulated",
      chainId: 1,
      initialBaseFeePerGas: 0,
      forking: { url: configVariable("RPC_URL_MAINNET"), blockNumber: 26330265 },
    },
    // Forked at the block test/fixtures/kyberswap-base-*-53435674.json was quoted at.
    "base-kyberswap": {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
      initialBaseFeePerGas: 0,
      forking: { url: configVariable("RPC_URL_BASE"), blockNumber: 53435674 },
    },
  },
});
