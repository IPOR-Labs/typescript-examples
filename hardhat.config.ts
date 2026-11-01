import { configVariable, defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

process.loadEnvFile(".env");

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
  },
});
