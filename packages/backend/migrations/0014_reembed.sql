-- Embeddings now carry the model's task prefix (nomic-embed-text:
-- "search_document: "). Vectors made without it are dropped; the embedder
-- recomputes them from the chunks, which are kept.

DELETE FROM chunk_vectors;
