import { beforeEach, describe, expect, it, vi } from 'vitest';

const findManyMock = vi.fn();

vi.mock('../src/client.js', () => ({
  prisma: {
    promptCache: {
      findMany: findManyMock,
      findFirst: vi.fn(),
    },
  },
}));

function encode(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => {
    view.setFloat32(i * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

function row(id: string, embedding: readonly number[], createdAt: Date = new Date(0)) {
  return {
    id,
    descriptionHash: id.padEnd(64, '0').slice(0, 64),
    embedding: encode(embedding),
    schemaSmithOutput: {},
    toolCoderOutput: '',
    hitCount: 0,
    createdAt,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeEach(() => {
  findManyMock.mockReset();
});

describe('lookupByEmbedding', () => {
  it('returns nearest live embeddings sorted by cosine similarity', async () => {
    findManyMock.mockResolvedValue([
      row('orthogonal', [0, 1]),
      row('near', [0.9, 0.1]),
      row('exact', [1, 0]),
    ]);

    const { lookupByEmbedding } = await import('../src/repositories/prompt-cache.js');
    const hits = await lookupByEmbedding(new Float32Array([1, 0]), {
      topK: 2,
      minSimilarity: 0,
    });

    expect(hits.map((hit) => hit.id)).toEqual(['exact', 'near']);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { expiresAt: { gt: expect.any(Date) } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    );
  });

  it('ignores malformed or dimension-mismatched embeddings', async () => {
    findManyMock.mockResolvedValue([
      { ...row('short', [1]), embedding: encode([1]) },
      { ...row('bad', [1, 0]), embedding: new Uint8Array([1, 2, 3]) },
      row('valid', [1, 0]),
    ]);

    const { lookupByEmbedding } = await import('../src/repositories/prompt-cache.js');
    const hits = await lookupByEmbedding(new Float32Array([1, 0]));

    expect(hits.map((hit) => hit.id)).toEqual(['valid']);
  });

  it('returns an empty list for empty query vectors without hitting Prisma', async () => {
    const { lookupByEmbedding } = await import('../src/repositories/prompt-cache.js');
    const hits = await lookupByEmbedding(new Float32Array());

    expect(hits).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
