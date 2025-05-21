import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getMarketSubstrates } from './get-market-substrates';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getMarketSubstrates', () => {
  it('should get market substrates of the market', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);
    const erc20MarketId = 7n;

    const marketSubstrates = await getMarketSubstrates(publicClient, {
      plasmaVault,
      marketId: erc20MarketId,
    });

    expect(marketSubstrates).toStrictEqual([
      "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0x0000000000000000000000009bca74f805ab0a22ddd0886db0942199a0feba71",
      "0x00000000000000000000000050d2c7992b802eef16c04feadab310f31866a545",
      "0x000000000000000000000000f736acf34ff7cd9b3565b73a1f15e652859bf322",
      "0x000000000000000000000000cce7d12f683c6dae700154f0badf779c0ba1f89a",
      "0x0000000000000000000000003b3fb9c57858ef816833dc91565efcd85d96f634",
      "0x000000000000000000000000b7de5dfcb74d25c2f21841fbd6230355c50d9308",
      "0x00000000000000000000000023e60d1488525bf4685f53b3aa8e676c30321066",
      "0x000000000000000000000000933b9ffee0ad3ef8e4dbb52688ea905826d73755",
    ]);
  }, 30_000);
});