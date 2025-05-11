// ./utils/image-processor.ts
import { logger } from './logger'; // Updated import path

/**
 * Interface for image extraction result
 */
interface ImageInfo {
  base64Content: string;
  format: string;
}

/**
 * Interface for image format markers
 */
interface ImageMarker {
  prefix: string;
  format: string;
}

/**
 * Extracts base64 content and format from a data URL string.
 * E.g., "data:image/jpeg;base64,xxxxxxxxxxxxxxx"
 * @param {string} dataUrl The full data URL string.
 * @returns {ImageInfo|null} An object { base64Content: string, format: string } or null if not found.
 */
export function extractBase64Image(dataUrl: string): ImageInfo | null {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return null;
    }

    const markers: ImageMarker[] = [
        { prefix: "data:image/png;base64,", format: "png" },
        { prefix: "data:image/jpeg;base64,", format: "jpeg" },
        { prefix: "data:image/jpg;base64,", format: "jpg" },
        { prefix: "data:image/gif;base64,", format: "gif" },
        { prefix: "data:image/svg+xml;base64,", format: "svg" }, // svg+xml -> svg
        { prefix: "data:image/webp;base64,", format: "webp" }
    ];

    for (const marker of markers) {
        if (dataUrl.startsWith(marker.prefix)) {
            const base64Content = dataUrl.substring(marker.prefix.length);
            logger.debug(`Found image of format: ${marker.format}`);
            return { base64Content, format: marker.format };
        }
    }

    logger.warn("No known base64 image marker found in the provided data URL:", dataUrl.substring(0, 50) + "...");
    return null;
}

/**
 * Decodes a base64 string to a Uint8Array (Bun compatible).
 * Bun has optimized Buffer operations, which are compatible with Node's Buffer
 * @param {string} base64String The base64 encoded string (without the data URI prefix).
 * @returns {Uint8Array} The decoded binary data
 */
export function decodeBase64Image(base64String: string): Uint8Array {
    // Bun uses Node.js Buffer API and has highly optimized Buffer operations
    return Buffer.from(base64String, 'base64');
}

/**
 * Utility to convert a data URL directly to a binary buffer.
 * Helpful for working with file APIs in Bun.
 * @param {string} dataUrl The complete data URL
 * @returns {Uint8Array|null} The decoded image data or null if invalid
 */
export function dataUrlToBuffer(dataUrl: string): Uint8Array | null {
    const imageInfo = extractBase64Image(dataUrl);
    if (!imageInfo) return null;
    
    return decodeBase64Image(imageInfo.base64Content);
}