
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { Chunk, EMBEDDING_DIMENSIONS } from '../../models/Chunk.js';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 32;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', MODEL_NAME, {
      quantized: true,
    }) as Promise<FeatureExtractionPipeline>;

    pipelinePromise = pipelinePromise.catch((error: unknown) => {
      pipelinePromise = null;
      throw error;
    });
  }

  return pipelinePromise;
}

/**
 * Generate normalized 384-dimensional embeddings.
 * The model is loaded once and input is processed in batches of 32.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (texts.some((text) => !text.trim())) {
    throw new Error('Cannot embed empty text');
  }

  const extractor = await getEmbedder();
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const output = await extractor(batch, {
      pooling: 'mean',
      normalize: true,
    });

    const vectors = output.tolist() as number[][];

    if (
      vectors.length !== batch.length ||
      vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)
    ) {
      throw new Error('Embedding model returned an unexpected shape');
    }

    embeddings.push(...vectors);
  }

  return embeddings;
}

/**
 * Embed and save chunks that do not have embeddings yet.
 * Returns the number of chunks embedded during this call.
 */
export async function embedLecture(lectureId: string): Promise<number> {
  const chunks = await Chunk.find({
    lectureId,
    $or: [
      { embedding: { $exists: false } },
      { embedding: { $size: 0 } },
    ],
  })
    .select('+embedding')
    .sort({ index: 1 })
    .exec();

  let embeddedCount = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map((chunk) => chunk.text));

    await Promise.all(
      batch.map(async (chunk, index) => {
        chunk.embedding = vectors[index];
        chunk.embeddingModel = MODEL_NAME;
        await chunk.save();
      }),
    );

    embeddedCount += batch.length;
  }

  return embeddedCount;
}
