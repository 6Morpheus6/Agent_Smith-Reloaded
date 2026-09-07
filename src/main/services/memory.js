const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// Drop retrieved memories below this cosine similarity so low-relevance snippets
// aren't injected into the prompt as authoritative "facts". all-minilm scores run
// lower than larger models, so this floor is modest; tune via XK_MEM_MIN_SIM.
const MIN_SIMILARITY = parseFloat(process.env.XK_MEM_MIN_SIM || '0.35');

// Pure helper (exported for tests): keep only hits at/above the floor.
function filterByFloor(results, floor = MIN_SIMILARITY) {
    return results.filter(r => typeof r.similarity === 'number' && r.similarity >= floor);
}

class MemoryManager {
    constructor() {
        try {
            if (app && app.getPath) {
                this.userDataPath = app.getPath('userData');
            } else {
                this.userDataPath = path.join(os.homedir(), '.config', 'xkaliber-agent');
            }
        } catch (e) {
            this.userDataPath = path.join(os.homedir(), '.config', 'xkaliber-agent');
        }
        
        if (!fs.existsSync(this.userDataPath)) {
            fs.mkdirSync(this.userDataPath, { recursive: true });
        }
        
        // Unified database for both UI and CLI
        this.vectorDBPath = path.join(this.userDataPath, 'xkaliber_vectors_v29.json');
        this.vectors = this.loadJSON(this.vectorDBPath, []);
        
        // Memory embeddings are served by LM Studio's OpenAI-compatible /v1/embeddings
        // endpoint. Load an embedding model in LM Studio and keep its local server
        // running; the base URL is supplied via setLlmBase() at startup.
        this.llmEmbeddingBase = null;
        // Embedding model id. null => auto-detect the loaded embedding model from
        // LM Studio's /v1/models. Override with XK_EMBED_MODEL or setEmbeddingModel().
        this.embeddingModel = process.env.XK_EMBED_MODEL || null;
        this.gpuVendor = 'GENERIC';
        // Optional legacy fallback only, used if it happens to be running. NOT required.
        this.ollamaUrl = 'http://127.0.0.1:11434/api';
    }

    setLlmBase(url) {
        this.llmEmbeddingBase = url || null;
    }

    setEmbeddingModel(model) {
        this.embeddingModel = model || null;
    }

    // Resolve which embedding model id to request from LM Studio. Prefers an explicit
    // override (XK_EMBED_MODEL / setEmbeddingModel), otherwise auto-detects an
    // embedding-capable model loaded in LM Studio via /v1/models and caches it.
    async resolveEmbeddingModel(base) {
        if (this.embeddingModel) return this.embeddingModel;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(`${base}/v1/models`, {
                headers: { 'Authorization': 'Bearer lm-studio' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (resp.ok) {
                const data = await resp.json();
                const ids = (data.data || []).map(m => m && m.id).filter(Boolean);
                const embed = ids.find(id => /embed|minilm|bge|nomic|gte|e5|sentence/i.test(id));
                if (embed) {
                    this.embeddingModel = embed; // cache for subsequent calls
                    return embed;
                }
            }
        } catch (e) { /* fall through to default below */ }
        // Last resort: most LM Studio builds route /v1/embeddings to the loaded
        // embedding model regardless of this id.
        return 'text-embedding-ada-002';
    }

    // PRIMARY embedding path: LM Studio's OpenAI-compatible /v1/embeddings.
    // Returns the vector, or null if LM Studio is unreachable or has no embedding
    // model loaded.
    async openAiEmbed(text) {
        if (!this.llmEmbeddingBase) return null;
        const base = String(this.llmEmbeddingBase).replace(/\/+$/, '').replace(/\/(v1|api)$/, '');
        try {
            const model = await this.resolveEmbeddingModel(base);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch(`${base}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer lm-studio' },
                body: JSON.stringify({ input: text, model }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.data?.[0]?.embedding || null;
        } catch (e) {
            return null;
        }
    }

    setGpuVendor(vendor) {
        this.gpuVendor = vendor;
        console.log(`MemoryManager: GPU Vendor set to ${vendor}`);
    }

    loadJSON(filePath, defaultValue) {
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            console.error(`Failed to load ${filePath}`, e);
        }
        return defaultValue;
    }

    saveJSON(filePath, data) {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
            return true;
        } catch (e) {
            console.error(`Failed to save ${filePath}`, e);
            return false;
        }
    }

    async getEmbedding(text) {
        // PRIMARY: LM Studio /v1/embeddings (load an embedding model in LM Studio).
        const lmResult = await this.openAiEmbed(text);
        if (lmResult) return lmResult;
        // OPTIONAL legacy fallback: Ollama, only if it happens to be running. NOT required.
        return await this.ollamaEmbed(text);
    }

    // Optional legacy fallback. Returns the vector or null. Ollama is NOT required for memory.
    async ollamaEmbed(text) {
        const performEmbed = async (retryOnFailure = true) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // Reduced to 15s timeout

                const response = await fetch(`${this.ollamaUrl}/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model: 'all-minilm', 
                        input: text,
                        keep_alive: "5m", // Keep in memory for 5 mins instead of -1 or 0
                        options: { num_gpu: 0 } // Force CPU for embeddings to save VRAM
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    if (response.status === 404 && retryOnFailure) {
                        console.log(`Model all-minilm not found in Ollama. Attempting to pull...`);
                        await this.pullModel('all-minilm');
                        return await performEmbed(false);
                    }
                    throw new Error(`Embedding failed: HTTP ${response.status} - ${await response.text().catch(()=>'')}`);
                }

                const data = await response.json();
                return data.embeddings?.[0] || data.embedding;
            } catch (e) {
                if (retryOnFailure) {
                    console.warn("Embedding failed, retrying once...", e.message);
                    await new Promise(r => setTimeout(r, 2000));
                    return await performEmbed(false);
                }
                console.error('Embedding error after retry', e);
                return null;
            }
        };

        return await performEmbed();
    }

    async pullModel(model) {
        try {
            const pullController = new AbortController();
            const pullTimeoutId = setTimeout(() => pullController.abort(), 300000); 
            const pullRes = await fetch(`${this.ollamaUrl}/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: model }),
                signal: pullController.signal
            });

            if (pullRes.ok && pullRes.body) {
                const reader = pullRes.body.getReader();
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }
            clearTimeout(pullTimeoutId);
        } catch (e) {
            console.error("Failed to pull model", e);
        }
    }

    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dotProduct = 0.0, normA = 0.0, normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    getCount() {
        return this.vectors.length;
    }

    clearMemory() {
        this.vectors = [];
        const persisted = this.saveJSON(this.vectorDBPath, this.vectors);
        return persisted ? { success: true } : { success: false, error: 'Memory cleared in memory only — the vector database could not be persisted (userData dir not writable or full). The change will be lost on restart.' };
    }

    async storeVector(text, metadata = {}) {
        const embedding = await this.getEmbedding(text);
        if (embedding) {
            this.vectors.push({ text, embedding, metadata, timestamp: Date.now() });
            const persisted = this.saveJSON(this.vectorDBPath, this.vectors);
            return persisted
                ? { success: true }
                : { success: false, error: 'Memory saved in memory only — the vector database could not be persisted (userData dir not writable or full). The memory will be lost on restart.' };
        }
        return { success: false, error: "Embedding failed. In LM Studio, load an embedding model and keep the local server running." };
    }

    async queryVectors(queryText, limit = 5) {
        const queryEmbedding = await this.getEmbedding(queryText);
        if (!queryEmbedding) return { success: false, error: "Embedding failed. In LM Studio, load an embedding model and keep the local server running." };

        const results = this.vectors.map(v => ({
            ...v,
            similarity: this.cosineSimilarity(queryEmbedding, v.embedding)
        }));

        results.sort((a, b) => b.similarity - a.similarity);
        // Apply the relevance floor BEFORE the top-K cut so we never pad the result
        // with weak matches just to reach `limit`.
        const relevant = filterByFloor(results);
        return { success: true, data: relevant.slice(0, limit).map(r => ({ text: r.text, metadata: r.metadata, similarity: r.similarity })) };
    }
}

const instance = new MemoryManager();
instance.filterByFloor = filterByFloor;
instance.MIN_SIMILARITY = MIN_SIMILARITY;
module.exports = instance;