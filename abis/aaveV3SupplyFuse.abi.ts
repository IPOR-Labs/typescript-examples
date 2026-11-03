import { parseAbi } from "viem";

// The fuse's enter and exit take one struct each. The Alpha sends them ABI-encoded as the data of a FuseAction.
export const aaveV3SupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "function enter(Enter data)",
  "struct Exit { address asset; uint256 amount; }",
  "function exit(Exit data)",
]);
