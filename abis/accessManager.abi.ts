import { parseAbi } from "viem";

export const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
  "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
  "error AccessManagerUnauthorizedAccount(address msgsender, uint64 roleId)",
  "error TooShortExecutionDelayForRole(uint64 roleId, uint32 executionDelay)",
  "function isTargetClosed(address target) view returns (bool)",
  "function schedule(address target, bytes data, uint48 when) returns (bytes32 operationId, uint32 nonce)",
  "function execute(address target, bytes data) payable returns (uint32)",
  "function cancel(address caller, address target, bytes data) returns (uint32)",
  "function updateTargetClosed(address target, bool closed)",
  "error AccessManagerNotScheduled(bytes32 operationId)",
  "error AccessManagerNotReady(bytes32 operationId)",
  "function getMinimalExecutionDelayForRole(uint64 roleId) view returns (uint256)",
  "function hashOperation(address caller, address target, bytes data) view returns (bytes32)",
  "function getSchedule(bytes32 id) view returns (uint48)",
]);
