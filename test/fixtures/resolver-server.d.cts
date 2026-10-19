export declare const caPath: string;
export declare const ca: Buffer;
export declare const key: Buffer;
export declare function startResolver(ip: string, host?: string): Promise<{ url: string; close: () => Promise<void> }>;
