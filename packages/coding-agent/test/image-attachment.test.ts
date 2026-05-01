import { describe, expect, it } from "vitest";
import { processImageAttachment } from "../src/utils/image-attachment.js";

describe("processImageAttachment", () => {
	it("converts raw bytes to ImageContent when resizing is disabled", async () => {
		const result = await processImageAttachment({
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
			autoResizeImages: false,
		});

		expect(result).toEqual({
			image: {
				type: "image",
				mimeType: "image/png",
				data: Buffer.from([1, 2, 3]).toString("base64"),
			},
		});
	});
});
