import { parseAbi } from "viem";

// Source: Chainlink aggregator interface, as read by ipor-webapp src/fusion/factory/hooks/use-price-feed-price.ts at 220fe2a0a.
export const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
