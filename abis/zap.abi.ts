import { parseAbi } from "viem";

// Source: ipor-webapp packages/fusion-sdk/src/abi/erc4626-zap-in-with-native-token.abi.ts at 220fe2a0a.
// This is the deployed zap's ZapInData. The struct on ipor-fusion main has an extra minimum-shares field,
// and a call encoded with it reverts against the deployed zap.
export const zapAbi = parseAbi([
  "struct Call { address target; bytes data; uint256 nativeTokenAmount; }",
  "struct ZapInData { address vault; address receiver; uint256 minAmountToDeposit; address[] assetsToRefundToSender; Call[] calls; }",
  "function zapIn(ZapInData zapInData) payable returns (bytes[])",
  "function ZAP_IN_ALLOWANCE_CONTRACT() view returns (address)",
  "error MinAmountToDepositIsZero()",
  "error InsufficientDepositAssetBalance()",
]);
