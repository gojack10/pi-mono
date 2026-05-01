import type { ImageContent } from "@mariozechner/pi-ai";
import { formatDimensionNote, resizeImage } from "./image-resize.js";

export interface ProcessImageAttachmentOptions {
	bytes: Uint8Array;
	mimeType: string;
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

export interface ProcessedImageAttachment {
	image: ImageContent;
	dimensionNote?: string;
}

/** Convert raw image bytes into an ImageContent attachment, resizing if enabled. */
export async function processImageAttachment(
	options: ProcessImageAttachmentOptions,
): Promise<ProcessedImageAttachment | null> {
	const base64 = Buffer.from(options.bytes).toString("base64");
	const autoResizeImages = options.autoResizeImages ?? true;

	if (!autoResizeImages) {
		return {
			image: { type: "image", data: base64, mimeType: options.mimeType },
		};
	}

	const resized = await resizeImage({ type: "image", data: base64, mimeType: options.mimeType });
	if (!resized) {
		return null;
	}

	return {
		image: { type: "image", data: resized.data, mimeType: resized.mimeType },
		dimensionNote: formatDimensionNote(resized),
	};
}
