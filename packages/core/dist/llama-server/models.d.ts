export interface ModelInfo {
    id: string;
    /** Router mode only, for example "loaded" or "unloaded". */
    status?: string;
}
export declare function listLlamaServerModels(baseUrl: string, options?: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
}): Promise<ModelInfo[]>;
