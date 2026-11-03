import { parseAbi } from "viem";

export const morphoSupplyFuseAbi = parseAbi([
  "struct MorphoSupplyFuseEnterData { bytes32 morphoMarketId; uint256 amount; }",
  "struct MorphoSupplyFuseExitData { bytes32 morphoMarketId; uint256 amount; }",
  "function enter(MorphoSupplyFuseEnterData data)",
  "function exit(MorphoSupplyFuseExitData data)",
]);
