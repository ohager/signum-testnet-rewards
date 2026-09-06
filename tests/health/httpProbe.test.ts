import { test, expect, describe } from "bun:test";
import { createHttpProbe } from "../../src/health/httpProbe.ts";
import type { TestnetClient, HeadBlock, TestnetSnapshot } from "../../src/chain/testnetClient.ts";

const HEAD: HeadBlock = {
  height: 980_544,
  blockId: "433423838390268815",
  generationSignature: "1e9a41399251cc310c8f0f9a626ae09618efdaebaa7013f99ca97a7b4175d217",
  generatorId: "4325295135044374377",
  generatorRS: "TS-R5VB-2B6J-2N8C-5BN3S",
  forgedAt: 1_800_000_000,
};

const snapshot = (localHeight: number): TestnetSnapshot => ({
  localHeight,
  globalHeight: localHeight,
  isScanning: false,
  lastBlockId: HEAD.blockId,
});

const unusedHere = () => Promise.reject(new Error("not used by the probe"));

const stubClient = (over: Partial<TestnetClient> = {}): TestnetClient => ({
  getSnapshot: async () => snapshot(980_544),
  getPeerCount: async () => 8,
  getHeadBlock: async () => HEAD,
  buildUnsignedMultiOut: unusedHere,
  buildUnsignedSend: unusedHere,
  ...over,
});

describe("createHttpProbe", () => {
  test("reports the head block and who forged it", async () => {
    const result = await createHttpProbe(stubClient())();
    expect(result.httpReachable).toBe(true);
    expect(result.head).toEqual(HEAD);
  });

  test("asks for the head block the snapshot named, not for a height", async () => {
    const asked: string[] = [];
    await createHttpProbe(
      stubClient({
        getHeadBlock: async (blockId) => {
          asked.push(blockId);
          return HEAD;
        },
      }),
    )();
    expect(asked).toEqual([HEAD.blockId]);
  });

  test("A MISSING HEAD BLOCK IS NOT AN UNREACHABLE NODE", async () => {
    const result = await createHttpProbe(
      stubClient({
        getHeadBlock: async () => {
          throw new Error("block api down");
        },
      }),
    )();
    expect(result.httpReachable).toBe(true);
    expect(result.localHeight).toBe(980_544);
    expect(result.head).toBeUndefined();
  });

  test("an unreachable node reports no head at all", async () => {
    const result = await createHttpProbe(
      stubClient({
        getSnapshot: async () => {
          throw new Error("down");
        },
      }),
    )();
    expect(result.httpReachable).toBe(false);
    expect(result.head).toBeUndefined();
  });

  test("a height increase between probes is recorded as block progress", async () => {
    let height = 980_544;
    const probe = createHttpProbe(
      stubClient({ getSnapshot: async () => snapshot(height) }),
      () => 1_700_000_000_000,
    );

    expect((await probe()).blockAdvancedAtMs).toBeUndefined();
    height += 1;
    expect((await probe()).blockAdvancedAtMs).toBe(1_700_000_000_000);
  });
});
